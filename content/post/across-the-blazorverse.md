---
title: "Across the blazorverse - Interchangable hosting models"
slug: "across-the-blazorverse"
date: 2020-02-09T12:00:00+02:00
lastmod: 2020-02-09T12:00:00+02:00
---

The other day I came across <a href="https://twitter.com/carlfranklin" title="@carlfranklin">Carl Franklins</a> very interesting <a href="http://www.appvnext.com/blog/2020/2/2/reuse-blazor-wasm-ui-in-blazor-server" title="Reuse Blazor WASM UI in Blazor Server">post on reusing UI components between blazor WASM and server projects</a> and I immediately liked it. Being able to debug components on the server while deploying a WASM app feels like the best of both worlds. I couldn't shake the feeling that there was more potential to the approach, hence this small post.

We're going for separation of user interface from hosting model, so why not have the Blazor components reside in their own shared project? Blazor components are just classes after all, so there's nothing preventing us from having a completely self-contained class library with all our .razor files.

