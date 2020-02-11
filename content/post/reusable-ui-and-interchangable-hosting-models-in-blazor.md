---
title: "Reusable UI and Interchangable hosting models in Blazor"
slug: "reusable-ui-and-interchangable-hosting-models-in-blazor"
date: 2020-02-11T10:00:00+02:00
lastmod: 2020-02-11T10:00:00+02:00
---

**Tl;dr: Enable clean and easy changing of hosting model of Blazor app by packaging your UI in a Razor Class Library and using inversion of control to provide hosting model-specific data providers to your views. In a Blazor WASM client project, implement the service using an HttpClient accessing an API. In a Blazor ServerSide (or during prerendering), implement the service using more direct access.**

*Source code is available at [https://github.com/joelving/blazor-hosting](https://github.com/joelving/blazor-hosting "Source code").*

The other day I came across [Carl Franklins](https://twitter.com/carlfranklin "@carlfranklin") very interesting [post on reusing UI components between blazor WASM and server projects](http://www.appvnext.com/blog/2020/2/2/reuse-blazor-wasm-ui-in-blazor-server "Reuse Blazor WASM UI in Blazor Server") and I was hooked. Being able to debug components on the server while deploying a WASM app would be a huge boon since I love the Visual Studio debugger but am reprehensive about deploying ServerSide Blazor to production.

Carls post does an excellent job of laying the foundation, but I couldn't shake the feeling that there was potential for more using that approach, though. Hence this small post.

## Wrapping up the UI

We're going for separation of user interface from hosting model, so why not have the Blazor components reside in their own shared project? The ASP.NET team has even been so kind as to design an entire SDK just for that purpose: Microsoft.NET.Sdk.Razor colloquially known as Razor Class Libraries (RCL).

Using RCLs are fantastically easy. We simply move all our Blazor components and static web assets (such as stylesheets) into the project, and the SDK will make sure everything is built and packaged for us to consume elsewhere.

{{< figure src="/assets/images/UI project.png" title="Razor Class Library" >}}

We can even move our stylesheets to the class library, as long as we remember the naming conventions for embedded resources. As per [the docs](https://docs.microsoft.com/en-us/aspnet/core/razor-pages/ui-class#create-an-rcl-with-static-assets "Create reusable UI using the Razor class library project in ASP.NET Core"), you can add a wwwroot-folder to your class library and have static assets served from it automagically under the path "_content/{library.name}/".

Suppose we name our UI project "UI" and copy the wwwroot folders from the sample apps (a "css" folder containing our site.css along with bootstrap and open-iconic) into it. We'll now be able to reach them at "/_content/UI/css/site.css" for instance. As long as we update the index.html and _host.cshtml respectively, we'll be fine.

### Consuming the UI

With that minor change you end up with a fallback _host.cshtml for the prerendered version similar to this:

{{< highlight html >}}
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Blazor WebAssembly Prerendered</title>
    <base href="~/" />
    <link href="/_content/ui/css/bootstrap/bootstrap.min.css" rel="stylesheet" />
    <link href="/_content/ui/css/site.css" rel="stylesheet" />
</head>
<body>
    <app>@(await Html.RenderComponentAsync<App>(RenderMode.ServerPrerendered))</app>

    <script src="_framework/blazor.webassembly.js"></script>
</body>
</html>
{{< /highlight >}}

## Hosting models and how to feed them data

With our UI nicely wrapped, we can reference it from either of three hosting models: Blazor ServerSide, Blazor WASM standalone, or (my favorite) Blazor WASM prerendered.
* Blazor ServerSide renders the components on the server and sends diffs to the client which then applies them.
  + Good: Initial load is blazing fast, since only a tiny library is required for setting up the SignalR connection to the server.
  - Bad: App interactions can be slow, since each interaction requires a roundtrip to the server.
* Blazor WASM as a standalone client can be hosted statically wherever you'd like and interacts with an API for data.
  + Good: Static file hosting can be cheap, local, performant, etc.
  - Bad: Initial load is slow, since entire Mono runtime must be downloaded.
* Blazor WASM prerendered delivers a fully populated landing page to look at while the WASM client downloads and bootstraps.
  + Good: Initial load *feels* fast, since data is prerendered and displayed immediately.
  - Bad: Requires a .NET runtime on the host to prerender the landing page.

Our sample weather forecast component needs to fetch the forecast. In the Visual Studio WASM template the component fetches the data from an API using an HttpClient. This breaks server side since it doesn't register an HttpClient by default. You could register it with the DI container and have it fetch the data via an API, but this scratches me the wrong way for two reasons:
1. Blazor ServerSide usually doesn't have an API. Creating additional HTTP endpoints for this seems redundant and a maintenance burden.
2. At best, we introduce an entire serialize-deserialize roundtrip for the data, delaying the important stuff. At worst, we end up hitting the network with delays orders of magnitude larger.

## The punchline: host-specific data providers
Having the UI component depend on an interface allows us to register different implementations for WASM and server side rendering, e.g. fetching from an API using an HttpClient for WASM, and directly accessing a provider for ServerSide and prerendering.

To get a semblance of clean architecture (see [Jason Taylors](https://twitter.com/jasontaylordev "@jasontaylordev") great [way to do this](https://github.com/jasontaylordev/CleanArchitecture "Clean architecture") or see [his talk at NDC London 2019](https://www.youtube.com/watch?v=Zygw4UAxCdg "Clean Architecture with ASP.NET Core 2.2 - Jason Taylor") on the topic) we'll define the interface needed to provide data to the UI in the UI project, and let the implementations reside in the respective hosting projects.

{{< highlight csharp >}}
// Defined in the UI project.
public interface IWeatherForecastService
{
	Task<WeatherForecast[]> GetForecastAsync(DateTime? startDate = null);
}

// Defined and registered in the WASM client
public class WeatherForecastService : IWeatherForecastService
{
	private readonly HttpClient Http;
	public WeatherForecastService(HttpClient http)
	{
		Http = http;
	}

	private const string url = "/WeatherForecast";
	public async Task<WeatherForecast[]> GetForecastAsync(DateTime? startDate = null)
	{
		return await Http.GetJsonAsync<WeatherForecast[]>(url);
	}
}

// Defined and registered in the ServerSide and hosted projects.
public class WeatherForecastService : IWeatherForecastService
{
	private readonly WeatherForecastProvider _provider;

	public WeatherForecastService(WeatherForecastProvider provider)
	{
		_provider = provider;
	}

	public Task<WeatherForecast[]> GetForecastAsync(DateTime? startDate = null)
		=> Task.FromResult(_provider.GetForecast(startDate));
}
{{< /highlight >}}

The WeatherForecastProvider is where our business logic resides. In our case, it's merely the code for generating randomized weather forecasts that's part of the project templates.
The only missing link is the API controller, which also has the WeatherForecastProvider injected and - like the server projects - passes on the data from it the WASM client.

{{< highlight csharp >}}
public class WeatherForecastProvider
{
	private static readonly string[] Summaries = new[]
	{
		"Freezing", "Bracing", "Chilly", "Cool", "Mild", "Warm", "Balmy", "Hot", "Sweltering", "Scorching"
	};

	public WeatherForecast[] GetForecast(DateTime? startDate = null)
	{
		startDate ??= DateTime.Now;
		var rng = new Random();
		return Enumerable.Range(1, 5).Select(index => new WeatherForecast
		{
			Date = startDate.Value.AddDays(index),
			TemperatureC = rng.Next(-20, 55),
			Summary = Summaries[rng.Next(Summaries.Length)]
		}).ToArray();
	}
}
{{< /highlight >}}

*That's it.* Now we can render our component serverside (either as a Blazor ServerSide project or during prerendering) with full debugging capabilities, or client side in WebAssembly. Besides the different application bootstrapping code, only the interface between the UI and the application logic changes - the UI components stay the same.

To recap, we:
- Moved all UI to a separate Razor Class Library.
- Updated the paths to our stylesheets to match the convention of assets embedded in libraries.
- Defined an interface for providing data to our UI component (in the UI project to keep things nice and clean).
- Defined and registered host-specific implementations of the interface providing data to the UI.
  - ServerSide Blazor and prerendered projects use a thin wrapper around the business logic.
  - WASM uses an HttpClient to request the data from an API controller, which in turn uses the same business logic.

*Source code is available at [https://github.com/joelving/blazor-hosting](https://github.com/joelving/blazor-hosting "Source code").*

---

Notes:

A word on prerendering: Using prerendering causes the OnInitialized methods of you blazor components to fire twice: Once during prerendering and once when the app is bootstrapped on the client. In the sample app where data is randomized on each call this means the prerendered data will be replaced with something potentially very different once the app bootstraps. While it's not very common to deliver random data, doing an expensive computation twice may be something to avoid. The [docs](https://docs.microsoft.com/en-us/aspnet/core/blazor/hosting-models?view=aspnetcore-3.1#stateful-reconnection-after-prerendering "ASP.NET Core Blazor hosting models") on the topic shows how to use a short-lived cache to avoid it.