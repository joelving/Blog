---
title: "Async isn't always async"
slug: "async-isnt-always-async"
date: 2024-06-30T22:22:00+02:00
lastmod: 2024-06-30T22:22:00+02:00
---

This is a long story about me recalling some of the finer details about how async-await works in dotnet, notably how a function returning a Task can execute synchronously.

With thanks to Stephen Toub, who is the reason I did not waste more time on this than I did - and apologies for what is probably going to be an embarassing mix-up of terms.

## TL;DR
Async-await is smart. If you call an async method that returns a task that is completed from the start, the caller won't schedule the remainder of it's execution as a continuation but continue synchronously. This means that what you thought would be a long-running task scheduled to the thread pool may in fact be a long-running synchronous call running on your current thread!

If you rely on tasks being scheduled, make sure they get scheduled by wrapping them in `Task.Run`, which explicitly queues the task on the thread pool.

## The setup

I was recently working on a library which included a `BackgroundService` for keeping important data (access tokens in my case) up-to-date. As I'm trying to get better at TDD, I was writing tests to ensure that it would behave properly, e.g., make the right calls to the identity provider by calling `BackgroundService.StartAsync()` manually.

The code looked something like this:
```csharp
var fakeHttpMessageHandler = new FakeMessageHandler(); // My HttpMessageHandler fake that logs every HttpMessageRequest and returns canned responses.
var httpClient = new HttpClient(fakeHttpMessageHandler);

var tcs = new TaskCompletionSource(); // Since the tokenManager is supposed to run in the background, it can be hard to tell when it's done. Triggering a TaskCompletionSource from an event handler allows us to await it as usual.
var tokenManager = new TokenManager(httpClient);
tokenManager.OnTokenChanged += tcs.SetResult();

await tokenManager.StartAsync(default);
await tcs.Task;

// Run assertions on
fakeHttpMessageHandler.Requests.Should().SatisfyRespectively(
    request => request...
);
```

The `TokenManager` is supposed to run in an infinite loop keeping the access token up-to-date, so it will look similar to this:
```csharp
public async Task ExecuteAsync()
{
    while (true)
    {
        var token = await tokenClient.FetchToken();

        // Omitted: Do something with the token

        OnTokenChanged?.Invoke(this, e); // Notify subscribers - I used a slightly different pattern inspired by Reactive Extensions with subscribers getting an IDisposable that they would attach their event handlers to and which would automatically deregister when disposed, but we're keeping it simple here.
    }
}
```

Now, I obviously won't be hitting an actual identity provider for my unit tests. As I mentioned in the code comment above, I use a fake `HttpMessageHandler` which returns canned responses. It has a `SendAsync` that looks something like this:

```csharp
protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
{
    return Task.FromResult(cannedResponse);
}
```

If you really know your async-await in dotnet, you may be slightly shaking your head at this point. I, however, was happily running my test expecting it to turn green (after seeing a red one, of course).

Alas, that was not to be.

## It really shouldn't do that...
My test was timing out. Or rather, it would just keep running until I killed it. Debugging showed it to be running inside the infinite loop of my `TokenManager.ExecuteAsync`, which was fine - it was supposed to do that! But for some reason, the rest of the test wasn't progressing to the `await tcs.Task;` statement. What gives?

Having looked at it before, I was pretty confident that `BackgroundService.StartAsync` would not be awaiting `TokenManager.ExecuteAsync` and sure enough, looking into the source code confirmed as much:
```csharp
public virtual Task StartAsync(CancellationToken cancellationToken)
{
    // Create linked token to allow cancelling executing task from provided token
    _stoppingCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

    // Store the task we're executing
    _executeTask = ExecuteAsync(_stoppingCts.Token);

    // If the task is completed then return it, this will bubble cancellation and failure to the caller
    if (_executeTask.IsCompleted)
    {
        return _executeTask;
    }

    // Otherwise it's running
    return Task.CompletedTask;
}
```
(https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Hosting.Abstractions/src/BackgroundService.cs)

`ExecuteAsync` is called *but not awaited*! Why does my code not continue past it?!

## Nerdysense is tingling
Now, something was itching in the back of my mind. Something about the state machine that the compiler sets up to manager continuations and how it deals with task completion...

I made a subtle change to my `FakeHttpMessageHandler`:
```csharp
protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
{
    await Task.Yield();
    return Task.FromResult(cannedResponse);
}
```

With that tiny change, my test ran exactly as expected. The `BackgroundService` was fired off, running in it's infinite loop, while the rest of the test immediately continued to await the signal from the `TaskCompletionSource`.

What made me try that change? In so many words: Stephen Toub.

A little over a year ago, Stephen Toub published a deep dive on async-await, a veritable tour de force of arcane dotnet knowledge: [How Async/Await Really Works in C#](https://devblogs.microsoft.com/dotnet/how-async-await-really-works/). If you do C#-development for a living, this is a must-read.

It's a great and thorough article. *Very thorough*. While I whole-heartedly recommend reading it all, I'll highlight the key point here:

{{< alert info >}}
If your task is already complete when returned, the continuation will run synchronously.
{{< /alert >}}

Before adding the innocent little `await Task.Yield()`, the `SendAsync`-method would return the canned response immediately *and synchronously* - no need to schedule anything. Whatever called that (probably something inside the `HttpClient`) would look at the task and go "hey, that's already done. No need to set up a state machine and track completion. We'll just continue processing it.". That in turn meant, that the `TokenClient.FetchToken`-method invoked in the infinite loop of the `TokenManager` would return immediately *and synchronously*.

So, everything inside my `BackgroundService.ExecuteAsync()` is running synchronously. Recall the body of the ´BackgroundService.StartAsync()` method:
```csharp
public virtual Task StartAsync(CancellationToken cancellationToken)
{
    // Create linked token to allow cancelling executing task from provided token
    _stoppingCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

    // Store the task we're executing
    _executeTask = ExecuteAsync(_stoppingCts.Token);

    // If the task is completed then return it, this will bubble cancellation and failure to the caller
    if (_executeTask.IsCompleted)
    {
        return _executeTask;
    }

    // Otherwise it's running
    return Task.CompletedTask;
}
```
I thought I was just storing a Task that would run in the background - scheduled to the thread pool - but nothing was ever being scheduled. What should have been "grab a reference and move on" became "run it to completion", which with an infinite loop requires some patience.

## The nitty-gritty details
If you really want to get into the gory details, grab yourself a tool to view some IL. I tried both ildasm, ILSpy and dotPeek - I found the latter the easiest to parse.

What you'll see - and what you can read in Stephen Toubs excellent article in [the third code block under the heading "MoveNext"](https://devblogs.microsoft.com/dotnet/how-async-await-really-works/#movenext) - is blocks like this (snippet for clarity):
```csharp
if (!awaiter.IsCompleted)
{
    num = (<>1__state = 1);
    <>u__2 = awaiter;
    <>t__builder.AwaitUnsafeOnCompleted(ref awaiter, ref this);
    return;
}
```

There's obviously a lot more going on but the point is, that it checks if the task is completed and only if it isn't, does it actually schedule a continuation on the thread pool.

So what can you do if you depend on it being scheduled? You can wrap it in `Task.Run` or - if you have access - you can configure the method call that executes synchronously with `.ConfigureAwait(ConfigureAwaitOptions.ForceYielding)` which, as the name implies, forces it to be scheduled on the thread pool.

So there you have it. My incredibly long-winded way of saying "it's only async if it has to be, so be careful how you fake it".

I hope it'll save you some gnashing of teeth.