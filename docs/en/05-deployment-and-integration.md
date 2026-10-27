# Deployment and Integration

> English | [中文](../05-部署与集成.md)

## 1. Requirements

| Purpose | Requirement |
| --- | --- |
| Building the editor | Node.js ≥ 20.19 (developed with 22.x) |
| Building the WPF library | .NET SDK 8.0+ (developed with the 9.0 SDK, target framework net8.0-windows) |
| Running the WPF control | .NET Desktop Runtime 8.0+ (or .NET Framework 4.8, see section 5) |
| Browser | Chrome / Edge 90+ (requires Canvas2D and ES2022) |

> Every dependency in this repository is installed **inside the project directory**:
> - npm dependencies → `node_modules/`, npm cache → `.cache/npm/`
> - NuGet packages → `.cache/nuget/packages/` (see `nuget.config`)
>
> The machine-wide environment stays clean; deleting the directory uninstalls everything.

## 2. Build

```bash
# install front-end dependencies once
npm install

# editor: type check + unit tests + production build
npm run editor:check
# output: dist/editor/ (index.html + assets/*.js + assets/*.css, ready for static hosting)

# WPF: build + unit tests + offscreen rendering verification + NuGet packaging
npm run dotnet:build
npm run dotnet:test      # 62 logic tests
npm run dotnet:probe     # render probe: images + pixel assertions + performance
npm run dotnet:pack      # output: artifacts/nuget/VectAnim.Wpf.1.0.0.nupkg

# everything at once
npm run all
```

Development mode:

```bash
npm run dev              # http://localhost:5173
dotnet run --project dotnet/VectAnim.Demo/VectAnim.Demo.csproj
```

## 3. Deploying the Editor

The editor is a pure static site: put `dist/editor/` on any static server (`base: './'` uses relative paths, so a subdirectory works as well).

### Nginx

```nginx
server {
    listen 80;
    server_name vectanim.example.com;

    root /var/www/vectanim;
    index index.html;

    # single-page app: fall back to index.html for every unmatched path
    location / {
        try_files $uri $uri/ /index.html;
    }

    # long cache for hashed static assets
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    # .vectanim.json needs the right MIME type and UTF-8
    location ~* \.json$ {
        charset utf-8;
        add_header Cache-Control "no-cache";
    }
}
```

### IIS / static hosting

- Make sure the MIME type of `.json` is `application/json`;
- When served from a sub-path (for example `/editor/`), no configuration change is needed — relative paths are already handled.

### Offline use

The editor needs no backend and can therefore:

- Be opened by double-clicking `dist/editor/index.html` (via `file://`) — note that browsers may restrict `localStorage` and downloads in that case, so a local static server is preferred;
- Be wrapped in an Electron / WebView2 shell as an intranet offline tool.

## 4. WPF Integration

### 4.1 NuGet package (recommended)

```bash
npm run dotnet:pack
# produces artifacts/nuget/VectAnim.Wpf.1.0.0.nupkg
```

In the target project:

```xml
<PackageReference Include="VectAnim.Wpf" Version="1.0.0" />
```

Or put the `.nupkg` into a local source:

```xml
<!-- nuget.config -->
<packageSources>
  <add key="local" value="D:\nuget-local" />
</packageSources>
```

### 4.2 Project reference

```xml
<ItemGroup>
  <ProjectReference Include="..\VectAnim.Wpf\VectAnim.Wpf.csproj" />
</ItemGroup>
```

### 4.3 Direct DLL reference

Copy `VectAnim.Wpf.dll` into the target project's `libs/` folder:

```xml
<ItemGroup>
  <Reference Include="VectAnim.Wpf">
    <HintPath>libs\VectAnim.Wpf.dll</HintPath>
  </Reference>
</ItemGroup>
```

### 4.4 Shipping document files with the application

```xml
<ItemGroup>
  <Content Include="panels\**\*.vectanim.json" CopyToOutputDirectory="PreserveNewest" />
</ItemGroup>
```

```csharp
Viewer.Source = Path.Combine(AppContext.BaseDirectory, "panels", "gear-demo.vectanim.json");
```

Or load from resources or a database:

```csharp
var json = File.ReadAllText(path);           // or read from a database / network
Viewer.LoadFromString(json, "db:panel-42");
```

## 5. .NET Framework 4.8 Support

The library targets `net8.0-windows`. If .NET Framework 4.8 is mandatory on site:

1. Create a `net48` class library and link in the sources under `dotnet/VectAnim.Wpf` (`Model` / `Expressions` / `Animation` / `Runtime` / `Rendering` / `Controls`);
2. Replace `System.Text.Json` with `Newtonsoft.Json`: write a `JsonConverter` for `ValueRef` (see the structure of `ValueRefJsonConverter`), or switch the `Model` classes to `[JsonProperty]`;
3. The remaining code (WPF rendering, the expression engine, animation scheduling) does not depend on .NET Core features and compiles as is (`Math.Clamp` needs a hand-written replacement and `record struct` must become a plain struct).

> net8.0 is the default because `System.Text.Json` is built in, performs better and needs no third-party package. If net48 is truly required, upgrading to .NET 8 is the better option — it is still in its long-term support window.

## 6. Runtime Integration Patterns

### 6.1 PLC / OPC polling thread

```csharp
public sealed class PlcBridge : IDisposable
{
    private readonly VectAnimViewer _viewer;
    private readonly CancellationTokenSource _cts = new();

    public PlcBridge(VectAnimViewer viewer)
    {
        _viewer = viewer;
        _ = Task.Run(PollAsync);
    }

    private async Task PollAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            var snapshot = new Dictionary<string, double>
            {
                ["RPM"] = await ReadTagAsync("DB1.DBD0"),
                ["Temp"] = await ReadTagAsync("DB1.DBD4"),
            };

            _viewer.SetVariables(snapshot);   // thread-safe, redraws once
            await Task.Delay(100, _cts.Token);
        }
    }

    private Task<double> ReadTagAsync(string tag) => Task.FromResult(0d);

    public void Dispose() => _cts.Cancel();
}
```

### 6.2 Switching between screens

```csharp
// Preload several documents and switch by changing Source (or LoadFromString from cache)
Viewer.Source = Path.Combine(baseDir, "panels", "line-1.vectanim.json");
```

> Every load rebuilds the render state. When switching screens frequently (less than 1 s apart), **pre-create several viewers** and toggle their `Visibility` inside a `Grid` to avoid repeated parsing.

### 6.3 Click interaction and alarm dialogs

```xml
<va:VectAnimViewer x:Name="Viewer" ShapeClick="OnShapeClick" />
```

```csharp
private void OnShapeClick(object sender, VectAnimShapeEventArgs e)
{
    if (e.ShapeId.StartsWith("alarm", StringComparison.Ordinal))
    {
        // business logic belongs here, not in an expression
        ShowAlarmDialog(e.ShapeName, e.CanvasPoint);
    }
}
```

## 7. Upgrade Strategy

- `SchemaVersion` follows `major.minor` semantics: `1.x` stays backwards compatible (fields are only added, semantics never change);
- The runtime accepts everything under `1.*`, warns on `2.x` and parses it on a best-effort basis;
- The editor always exports `1.0`, and extension fields (`Opacity` / `LineCap` / `Scale`, …) default to identity behaviour, so an older runtime reading a newer file never draws anything wrong — it simply ignores the new features.

## 8. Deliverables

| Deliverable | Path | Notes |
| --- | --- | --- |
| Editor static site | `dist/editor/` | Ready to deploy |
| Runtime library | `artifacts/nuget/VectAnim.Wpf.1.0.0.nupkg` or `dotnet/VectAnim.Wpf/bin/Release/net8.0-windows/VectAnim.Wpf.dll` | Reference and use |
| Demo application | `dotnet/VectAnim.Demo/` | Runs out of the box, with variable injection and a background-thread sample |
| Sample documents | `samples/*.vectanim.json` | Gear transmission and an industrial HMI panel |
| Documentation | `docs/` (English in `docs/en/`) | Architecture, schema, editor guide, control API, deployment |
| Verification output | `artifacts/` | Smoke report, render screenshots, performance data |
