---
title: "Across the blazorverse - Interchangable hosting models"
slug: "across-the-blazorverse"
date: 2020-02-09T12:00:00+02:00
lastmod: 2020-02-09T12:00:00+02:00
---

**Tl;dr: Enable clean and easy changing of hosting model of Blazor app by using dependency injection to provide hosting model-specific data providers to your views. E.g. have your weather forecast view depend on an IWeatherForecastService. In a Blazor WASM client project, implement the service using an HttpClient accessing an API. In a Blazor ServerSide (or during prerendering), implement the service using more direct access.**

*Source code is available at [https://github.com/joelving/blazor-hosting](https://github.com/joelving/blazor-hosting "Source code").

The other day I came across [Carl Franklins](https://twitter.com/carlfranklin "@carlfranklin") very interesting [post on reusing UI components between blazor WASM and server projects](http://www.appvnext.com/blog/2020/2/2/reuse-blazor-wasm-ui-in-blazor-server "Reuse Blazor WASM UI in Blazor Server") and I immediately liked it. Being able to debug components on the server while deploying a WASM app feels like the best of both worlds. I couldn't shake the feeling that there was more potential to the approach though, hence this small post.

We're going for separation of user interface from hosting model, so why not have the Blazor components reside in their own shared project? Blazor components are just classes after all, so there's nothing preventing us from having a completely self-contained class library with all our .razor files.

With our UI nicely wrapped, we can reference it from either of three hosting models: Blazor ServerSide, Blazor WASM standalone, or (my favorite) Blazor WASM prerendered.
* Blazor ServerSide renders the components on the server and sends diffs to the client which then applies them.
  + Good: Initial load is blazing fast, since only a tiny library is required for setting up the SignalR connection to the server.
  - Bad: App interactions can be slow, since each interaction requires a roundtrip to the server.
* Blazor WASM standalone can be hosted statically wherever you'd like and interacts with an API for data.
  + Good: Static file hosting can be cheap, local, performant, etc.
  - Bad: Initial load is slow, since entire Mono runtime must be downloaded.
* Blazor WASM prerendered delivers a fully populated landing page to look at while the WASM app downloads and bootstraps.
  + Good: Initial load *feels* fast, since data is prerendered and displayed immediately.
  - Bad: Requires a .NET runtime on the host to prerender the landing page.

Our sample weather forecast component needs to fetch the forecast. In the Visual Studio WASM template the component fetches the data from an API using an HttpClient. This breaks server side since it doesn't register an HttpClient by default. You could register it with the DI container and have it fetch the data via an API, but this scratches me the wrong way for two reasons:
1. Blazor ServerSide usually doesn't have an API. Creating additional HTTP endpoints for this seems redundant and a maintenance burden.
2. At best, we introduce an entire serialize-deserialize roundtrip for the data, delaying the important stuff.

**Now for the punchline.** Having the UI component depend on an interface allows us to register different implementations for WASM and server side rendering, e.g. fetching from an API using an HttpClient for WASM, and directly accessing a provider for ServerSide and prerendering.

To get a semblance of clean architecture (see [Jason Taylors](https://twitter.com/jasontaylordev "@jasontaylordev") great [way to do this](https://github.com/jasontaylordev/CleanArchitecture "Clean architecture") or see [his talk at NDC London 2019](https://www.youtube.com/watch?v=Zygw4UAxCdg "Clean Architecture with ASP.NET Core 2.2 - Jason Taylor") on the topic) we'll define the interface needed to provide data to the UI in the UI project, and let the implementations reside in the respective hosting projects.

*That's it.* Now we can render our component serverside (either as a Blazor ServerSide project or during prerendering) with full debugging capabilities, or client side in WebAssembly. Besides the different application bootstrapping code, only the interface between the UI and the application logic changes - the UI components stay the same.

---

Notes:

A word on prerendering: Using prerendering causes the OnInitialized methods of you blazor components to fire twice: Once during prerendering and once when the app is bootstrapped on the client. In the sample app where data is randomized on each call this means the prerendered data will be replaced with something potentially very different once the app bootstraps. While it's not very common to deliver random data, doing an expensive computation twice may be something to avoid. The [docs](https://docs.microsoft.com/en-us/aspnet/core/blazor/hosting-models?view=aspnetcore-3.1#stateful-reconnection-after-prerendering "ASP.NET Core Blazor hosting models") on the topic shows how to use a short-lived cache to avoid it.