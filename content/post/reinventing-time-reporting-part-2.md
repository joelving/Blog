---
title: "Reinventing time reporting with modern .NET - part 2"
slug: "reinventing-time-reporting-modern-dot-net-part-2"
date: 2018-11-14T15:30:00+02:00
---

This post is part of a series exploring some of the newest features of .Net.
[Last time]({{< relref "#anchors" >}}) we looked at how we can use pipes for parsing stream-data with very little overhead. We used it to built our own minimal iCal-parser, to be used in a remake of a time reporting tool for contractors like myself.

In this installment, we'll add a background queue and processor to decouple the fetching and parsing from our web interface. We'll do this using the new IHostedService interface allowing us to run tasks in the background with SignalR to give us live updates on their progress.

The code for this project can be found on [GitHub](https://github.com/joelving/Khronos) and has been updated for this post. I've also fixed a nasty bug in my buffer extensions, so if you've used the code for anything, please update accordingly.

## Don't keep me waiting
We're fetching a bunch of data (iCal feeds), parsing it and storing the parsed result in a database. This could potentially be quite time-consuming, even though our parser was crazy fast, so we don't want to block our client while we work.

So how do we do it? We need to offload the processing to something other than our request thread. Working with Azure, I'd usually look to WebJobs, but with the introduction of the IHostedService interface, we get the same power without ever leaving the context of our app. Neat, since we'll have a much easier time shuttling messages back and forth as we shall see.

Basically, what we'll need is pretty close to what [Luke Latham wrote about](https://docs.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services#queued-background-tasks): A singleton thread-safe queue which we can queue jobs to, and a processor inheriting from IHostedService, which can dispatch the jobs for processing.

So we need a straightforward queue:
{{< highlight csharp >}}
public interface IBackgroundQueue<T>
{
	Task EnqueueAsync(T job, CancellationToken cancellationToken);

	Task<(T job, Action callback)> DequeueAsync(CancellationToken cancellationToken);
}
{{< /highlight >}}

A simple processor:
{{< highlight csharp >}}
public interface IBackgroundJobProcessor<T>
{
	Task ProcessJob((T job, Action callback) job, CancellationToken cancellationToken);
}
{{< /highlight >}}

And something to dispatch from one to the other:
{{< highlight csharp >}}
public class BackgroundQueueService<T> : BackgroundService
{
	public IBackgroundQueue<T> TaskQueue { get; }
	private readonly ILogger _logger;
	private readonly IServiceScopeFactory _scopeFactory;

	public BackgroundQueueService(IBackgroundQueue<T> taskQueue, ILoggerFactory loggerFactory, IServiceScopeFactory scopeFactory)
	{
		TaskQueue = taskQueue;
		_logger = loggerFactory.CreateLogger<BackgroundQueueService<T>>();
		_scopeFactory = scopeFactory;
	}

	private string ThreadKind
		=> Thread.CurrentThread.IsThreadPoolThread ? "thread pool" : "non-thread pool";
	private string ThreadDescription
		=> $"thread {Thread.CurrentThread.ManagedThreadId} which is a {ThreadKind} thread";
	protected async override Task ExecuteAsync(CancellationToken cancellationToken)
	{
		_logger.LogInformation($"Queue Service is starting on {ThreadDescription}.");
		
		while (!cancellationToken.IsCancellationRequested)
		{
			var item = await TaskQueue.DequeueAsync(cancellationToken);

			Task.Run(async () =>
			{
				if (cancellationToken.IsCancellationRequested)
					return;

				using (var scope = _scopeFactory.CreateScope())
				{
					var logger = scope.ServiceProvider.GetRequiredService<ILogger<IBackgroundJobProcessor<T>>>();
					logger.LogInformation($"Processing job on thread {Thread.CurrentThread.ManagedThreadId} which is a {ThreadKind} thread.");
					var processor = scope.ServiceProvider.GetRequiredService<IBackgroundJobProcessor<T>>();

					// The queue is running on it's own thread, dispatching jobs to the thread pool. This is fine since the processing is async and non-blocking.
					await processor.ProcessJob(item, cancellationToken);
				}
			}, cancellationToken);
		}

		_logger.LogInformation("Queue Service is stopping.");
	}
}
{{< /highlight >}}

A few interesting things going on here.
First, the types are a little strange with a callback action tucked in there alongside the job. It's used by the queue to keep track of job completion so it can enforce a maximum number of simultaneous jobs running.
Second, we have an implicit requirement that our DequeueAsync task only complete when there's a job to process. We'll see in a second how we can accomplish this.
Third, while our queue itself runs in its own thread, we fire off our jobs *to the thread pool* without awaiting them. It's crucial that the queue runs in it's own non-thread poll thread, since running it on the thread pool would permanently leave us with a thread fewer to process requests. On the other hand, since our processing of jobs are non-blocking and short-lived, we're okay dispatching them to the thread pool.

To wire it all up, we'll add the following to our ConfigureServices in our Startup class:
{{< highlight csharp >}}
    services.AddSingleton<IBackgroundQueue<SyncJob>, SyncJobQueue>();
    services.AddTransient<IBackgroundJobProcessor<SyncJob>, SyncJobProcessor>();
    services.AddHostedService<BackgroundQueueService<SyncJob>>();
{{< /highlight >}}
Where SyncJob is the type of job we want to process, SyncJobQueue and SyncJobProcessor implementations of the queue and processor respectively.

With a little logging we'll see something like the following:
*Khronos.Web.Server.Services.BackgroundQueueService:Information: Queue Service is starting on thread 1 which is a non-thread pool thread.*
*Khronos.Web.Server.Services.IBackgroundJobProcessor:Information: Processing job on thread 8 which is a thread pool thread.*
Our tasks run in the contexts we expected, yay!

I promised to get back to how we could await dequeueing work items from our queue. In essence, our queue is an enhanced ConcurrentQueue:
{{< highlight csharp >}}
public class SyncJobQueue : IBackgroundQueue<SyncJob>
{
	private ConcurrentQueue<SyncJob> _workItems = new ConcurrentQueue<SyncJob>();
	private SemaphoreSlim _queuedItems = new SemaphoreSlim(0);
	private SemaphoreSlim _maxQueueSize;

	public SyncJobQueue(int maxQueueSize)
	{
		_maxQueueSize = new SemaphoreSlim(maxQueueSize);
	}

	public async Task EnqueueAsync(SyncJob job, CancellationToken cancellationToken)
	{
		if (job == null)
			throw new ArgumentNullException(nameof(job));

		// This causes callers to wait until there's room in the queue.
		await _maxQueueSize.WaitAsync(cancellationToken);
		_workItems.Enqueue(job);
		_queuedItems.Release();
	}

	public async Task<(SyncJob job, Action callback)> DequeueAsync(CancellationToken cancellationToken)
	{
		// This ensures we can never dequeue unless the semaphore has been increased by a corresponding release.
		await _queuedItems.WaitAsync(cancellationToken);
		_workItems.TryDequeue(out var job);

		return (job, () => _maxQueueSize.Release());
	}
}
{{< /highlight >}}

See it? We keep a SemaphoreSlim with an initial count of 0. That means that any attempt to dequeue an item will have to wait until someone calls release on the SemaphoreSlim. This happens in the Enqueue method. This is actually the same trick used in the BlockingCollection class, though it has some additional functionality like signalling completion, which we don't need here (we'll let app shutdown be our completion/abortion signal).

I've augmented Lukes implementation with another Semaphore (_maxQueueSize), which effectively applies back-pressure ensuring that we never have more than a *maxQueueSize* jobs running at a time. The downside to this approach is that we have to pass around a delegate which releases the semaphore when no more processing will occur. We also have to make sure that the delegate will **always** be invoked regardless of any exception, so it should be called in finally block following the processing. Definitely too much responsibility for a library, but we're ok doing it in our own sandbox.

> I feel clever writing this. Too clever, the kind that experience teach you to be suspicious about - so if you see an issue with the approach, please let me know!

## Are we there yet?
Now we can process our jobs asynchronously in the background, but we have no way of knowing when they're done. I hate polling so we need a way to let our job processor tell the client when it's done. Maybe we can even stuff a few helpful status messages in there along the way, so the user has an idea how it's going.

Enter SignalR...

I first tried SignalR when it came out for .NET Framework some years ago. It was great, but I had little occasion to use it, so nothing came of it. SignalR for .Net Core is everything I remember and more. Easily configurable with a simplified API - it's a pleasure to work with.

At the core of SignalR is the Hub. Hubs are SignalR equivalents of MVC controllers. Your client connects to these (actually you connect to the server, and SignalR takes care of routing to the hubs you specify) and invokes commands on it like action methods on controllers. The power comes from the hubs ability to invoke commands on the client and not just return some data.

What make hubs more than just an endpoint for your websocket connection is groups. Groups allow you to group (*cough*) connected clients by some key and invoke methods on them all with a single call.
Adding a user to a group is as simple as calling:
{{< highlight csharp >}}
await Groups.AddToGroupAsync(Context.ConnectionId, groupName);
{{< /highlight >}}
where groupName is a string. Then you can invoke methods on all clients in the group using
{{< highlight csharp >}}
await Clients.Groups(groupName).SendAsync(methodName, obj, obj, obj..., cancellationToken)
{{< /highlight >}}
You can even have [strongly-typed hubs](https://docs.microsoft.com/en-us/aspnet/core/signalr/hubs#strongly-typed-hubs) which we'll use here.

We can thus share two interfaces between client and server:
{{< highlight csharp >}}
public interface ICalendarHub
{
	Task ListCalendars();
	Task GetCalendar(GetCalendarCommand command);
	Task AddCalendar(AddCalendarCommand command);
	Task RefreshCalendar(RefreshCalendarCommand command);
}
{{< /highlight >}}
and
{{< highlight csharp >}}
public interface ICalendarClient
{
	Task ReceiveCalendars(ListCalendarsResult result);
	Task ReceiveCalendar(GetCalendarResult result);
	Task CalendarAdded(AddCalendarResult result);
	Task CalendarRefreshing(RefreshCalendarResult result);
	Task SetProgress(JobProgressResult result);
}
{{< /highlight >}}
No more magic strings. We'll even strongly type the payloads, so we don't accidentally switch out a task id for a calendar name or something like it.

So our hub ends up looking a bit like this:
{{< highlight csharp >}}
public class CalendarHub : Hub<ICalendarClient>, ICalendarHub
{
	// ...
	public async Task ListCalendars()
		=> // Omitted for brevity

	public async Task GetCalendar(GetCalendarCommand command)
		=> // Omitted for brevity

	public async Task AddCalendar(AddCalendarCommand command)
	{
		// Omitted for brevity
	}

	public async Task RefreshCalendar(RefreshCalendarCommand command)
	{
		var exists = await _dbContext.CalendarFeeds.AnyAsync(c => c.Url == command.Url);
		if (!exists)
		{
			await Clients.Caller.CalendarRefreshing(new RefreshCalendarResult { ErrorMessages = new List<string> { "The calendar isn't registered." } });
			return;
		}

		var job = new SyncJob
		{
			Id = Guid.NewGuid(),
			FeedUrl = command.Url,
			Owner = Context.User.Identity?.Name
		};

		await _syncJobQueue.EnqueueAsync(job, Context.ConnectionAborted);

		await Clients.Caller.CalendarRefreshing(new RefreshCalendarResult
		{
			Success = true,
			JobId = job.Id,
			Url = command.Url
		});

		await SubscribeToJob(job.Id);
	}
	
	public async Task SubscribeToJob(Guid jobId)
	{
		await Groups.AddToGroupAsync(Context.ConnectionId, $"{nameof(SyncJob)}:{jobId}");
		if (_progressCache.ContainsKey(jobId))
		{
			var (running, progress) = _progressCache[jobId];
			await Clients.Caller.SetProgress(new JobProgressResult { Success = true, JobId = jobId, Running = running, Progress = progress });
		}
	}

	public async Task UnsubscribeFromJob(Guid jobId)
	{
		await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"{nameof(SyncJob)}:{jobId}");
	}
}
{{< /highlight >}}

When a client requests an update of a calendar, we automatically subscribe it to updates on the progress of that job by adding it to a uniquey named group. By using groups instead connection Ids we automagically support multiple devices, changing connections and so on.

We'll connect our client to the hub, so it can invoke a method to update a progress indicator on the client. But we still need to get the message from our job processor to the hub. Thankfully, we can use DI for this.
We can't get the complete hub, which is probably good, since it contains a lot of state with plenty of room for us to mess up. What we can get is a HubContext, which can access groups and clients. Plenty for our purpose.

Bringing it all together, we can write our job processor:
{{< highlight csharp >}}
public class SyncJobProcessor : IBackgroundJobProcessor<SyncJob>
{
	private readonly IHubContext<CalendarHub, ICalendarClient> _hubContext;

	public SyncJobProcessor(
		IHubContext<CalendarHub, ICalendarClient> hubContext
		)
	{
		_hubContext = hubContext;
	}

	public async Task ProcessJob((SyncJob job, Action callback) data, CancellationToken cancellationToken)
	{
		var (job, callback) = data;
		try
		{
			await SetProgress(job.Id, true, "Fetching iCal feed.", _hubContext);
			// Make sure to pass response stream off to pipe before buffering. Otherwise, we'd not see much benefit of using pipes.
			var response = await _httpClient.GetAsync(job.FeedUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
			if (!response.IsSuccessStatusCode)
			{
				await SetProgress(job.Id, true, $"Failed to fecth iCal feed: {response.ReasonPhrase}.", _hubContext);
				return;
			}

			await SetProgress(job.Id, true, "Parsing iCal feed.", _hubContext);
			var events = await UTF8Parser.ProcessFeed(await response.Content.ReadAsStreamAsync());
			
			// Store parsed data in DB - omitted for brevity

			await SetProgress(job.Id, false, $"Done", _hubContext);
		}
		catch (Exception ex)
		{
			await SetProgress(job.Id, false, $"Failure!\n{ex}", _hubContext);
		}
		finally
		{
			// Release our queue semaphore allowing an additional item to be processed.
			callback();
		}
	}

	private async Task SetProgress(Guid jobId, bool running, string progress, IHubContext<CalendarHub, ICalendarClient> hubContext)
	{
		await hubContext.Clients.Groups($"{nameof(SyncJob)}:{jobId}").SetProgress(new JobProgressResult { Success = true, JobId = jobId, Running = running, Progress = progress });
	}
}
{{< /highlight >}}

Now everyone who's subscribed to the group will get updates on the progress. Fantastic! Note how I'm calling the callback in the finally-block? That's the signal to release the _maxQueueSize-semaphore in our queue, so it will accept a new job.

## Don't forget Polly!
In our job processor above, we fetch the iCal-feed using HTTP. But what if it fails? If the error seems transient, we may want to retry it potentially with a backing off scheme. Using Polly and the new HttpClientFactory, we'll simply register a named http client in our Startup class:
{{< highlight csharp >}}
services.AddHttpClient("RetryBacking")
	.ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler())
	.AddTransientHttpErrorPolicy(builder => builder.WaitAndRetryAsync(new[]
	{
		TimeSpan.FromSeconds(1),
		TimeSpan.FromSeconds(3),
		TimeSpan.FromSeconds(5)
	}));
{{< /highlight >}}
which will register a HttpClient that will retry three times when encountering what it deems to be transient errors, waiting 1 second the first time, 3 the second and 5 the last time. In our constructor, we'll do:
{{< highlight csharp >}}
public SyncJobProcessor(IHttpClientFactory httpClientFactory)
{
	_httpClient = httpClientFactory.CreateClient("RetryBacking");
}
{{< /highlight >}}

[There's other ways to do it](https://docs.microsoft.com/en-us/dotnet/standard/microservices-architecture/implement-resilient-applications/use-httpclientfactory-to-implement-resilient-http-requests), but I had trouble getting the typed-client approach to work using a BackgroundService - presumably since it's not added to the DI container. If you know how to accomplish it, I'd love to hear it.


## Until next time
There we have it. Jobs can be requested, added to a queue, dispatched by a queue service running in the background, processed on a thread pool-thread with http retries and continuous progress updates delivered via SignalR to all subscribers.

This was already a long post - thank you for sticking with me. As always (this is my second post, 1-2-always), if you’ve spotted any errors, poor design choices or other possibilities for improvement, please let me know by filing a pull request against [this sites repo](https://github.com/joelving/Blog) (or comment wherever this post was shared).

Next time we'll build a frontend using Blazor! We'll skip MVC altogether and go all-in on SignalR. I'll also experiment with some state management patterns inspired by the React-world, namely Redux.