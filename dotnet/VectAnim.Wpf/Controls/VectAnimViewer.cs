using System.ComponentModel;
using System.Diagnostics;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using VectAnim.Wpf.Model;
using VectAnim.Wpf.Rendering;
using VectAnim.Wpf.Runtime;
using VectAnim.Wpf.Serialization;
using ShapePath = System.Windows.Shapes.Path;

namespace VectAnim.Wpf.Controls;

/// <summary>
/// VectAnim runtime rendering control.
///
/// Usage:
/// <code>
/// &lt;va:VectAnimViewer x:Name="Viewer" Source="panels/gear.vectanim.json" AutoPlay="True" /&gt;
/// Viewer.SetVariable("RPM", 1200);
/// </code>
///
/// Design notes:
///  - Derives from <see cref="FrameworkElement"/> and overrides OnRender; creates no Shape objects by default;
///  - The animation loop hooks CompositionTarget.Rendering so it stays in sync with render frames without a UI timer;
///  - SetVariable may be called from any thread and switches to the UI thread internally;
///  - Externally written variables take precedence over built-in animation until the external mark is cleared.
/// </summary>
public class VectAnimViewer : FrameworkElement, IDisposable
{
    private readonly SceneRenderer _scene = new();
    private readonly VectAnimRuntime _runtime = new();
    private readonly List<ShapePath> _shapeVisuals = new();
    private readonly List<MatrixTransform> _shapeTransforms = new();
    private readonly Dictionary<string, long> _externalTimestamps = new(StringComparer.Ordinal);
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly List<ValidationIssue> _validationIssues = new();

    private VisualCollection? _visuals;
    private double _lastFrameSeconds;
    private bool _renderingHooked;
    private bool _isPlaying;
    private bool _disposed;
    private string? _currentSource;
    private string? _hoveredShapeId;
    private int _updateDepth;
    private bool _invalidatePending;

    static VectAnimViewer()
    {
        FocusableProperty.OverrideMetadata(typeof(VectAnimViewer), new FrameworkPropertyMetadata(false));
    }

    /// <summary>Creates the control.</summary>
    public VectAnimViewer()
    {
        ClipToBounds = true;
        SnapsToDevicePixels = false;
        RenderOptions.SetEdgeMode(this, EdgeMode.Unspecified);
        _runtime.Variables.Reset();
    }

    #region Dependency properties

    /// <summary>Document path (.vectanim.json). Setting it loads the document automatically.</summary>
    public static readonly DependencyProperty SourceProperty = DependencyProperty.Register(
        nameof(Source),
        typeof(string),
        typeof(VectAnimViewer),
        new FrameworkPropertyMetadata(null, FrameworkPropertyMetadataOptions.AffectsRender, OnSourceChanged));

    /// <summary>Whether to start playing automatically after loading.</summary>
    public static readonly DependencyProperty AutoPlayProperty = DependencyProperty.Register(
        nameof(AutoPlay),
        typeof(bool),
        typeof(VectAnimViewer),
        new PropertyMetadata(false, OnAutoPlayChanged));

    /// <summary>Whether built-in animation is enabled (external variables still work when disabled).</summary>
    public static readonly DependencyProperty AnimationEnabledProperty = DependencyProperty.Register(
        nameof(AnimationEnabled),
        typeof(bool),
        typeof(VectAnimViewer),
        new PropertyMetadata(true, OnAnimationEnabledChanged));

    /// <summary>Animation speed multiplier.</summary>
    public static readonly DependencyProperty AnimationSpeedProperty = DependencyProperty.Register(
        nameof(AnimationSpeed),
        typeof(double),
        typeof(VectAnimViewer),
        new PropertyMetadata(1.0));

    /// <summary>Render mode.</summary>
    public static readonly DependencyProperty RenderModeProperty = DependencyProperty.Register(
        nameof(RenderMode),
        typeof(VectAnimRenderMode),
        typeof(VectAnimViewer),
        new PropertyMetadata(VectAnimRenderMode.Drawing, OnRenderModeChanged));

    /// <summary>Scale fit mode.</summary>
    public static readonly DependencyProperty StretchProperty = DependencyProperty.Register(
        nameof(Stretch),
        typeof(VectAnimStretch),
        typeof(VectAnimViewer),
        new FrameworkPropertyMetadata(VectAnimStretch.Uniform, FrameworkPropertyMetadataOptions.AffectsRender));

    /// <summary>Extra zoom (around the control center).</summary>
    public static readonly DependencyProperty ZoomProperty = DependencyProperty.Register(
        nameof(Zoom),
        typeof(double),
        typeof(VectAnimViewer),
        new FrameworkPropertyMetadata(1.0, FrameworkPropertyMetadataOptions.AffectsRender, null, CoerceZoom));

    /// <summary>Extra horizontal offset (control coordinates).</summary>
    public static readonly DependencyProperty OffsetXProperty = DependencyProperty.Register(
        nameof(OffsetX),
        typeof(double),
        typeof(VectAnimViewer),
        new FrameworkPropertyMetadata(0.0, FrameworkPropertyMetadataOptions.AffectsRender));

    /// <summary>Extra vertical offset (control coordinates).</summary>
    public static readonly DependencyProperty OffsetYProperty = DependencyProperty.Register(
        nameof(OffsetY),
        typeof(double),
        typeof(VectAnimViewer),
        new FrameworkPropertyMetadata(0.0, FrameworkPropertyMetadataOptions.AffectsRender));

    /// <summary>Whether to respond to mouse interaction (clicking and hovering shapes).</summary>
    public static readonly DependencyProperty InteractiveProperty = DependencyProperty.Register(
        nameof(Interactive),
        typeof(bool),
        typeof(VectAnimViewer),
        new PropertyMetadata(true));

    /// <summary>
    /// Validity period of external writes (milliseconds). When greater than 0, an externally written variable
    /// is handed back to built-in animation after this time without another write. 0 keeps external priority forever (explicit clearing required).
    /// </summary>
    public static readonly DependencyProperty ExternalWriteTimeoutProperty = DependencyProperty.Register(
        nameof(ExternalWriteTimeout),
        typeof(double),
        typeof(VectAnimViewer),
        new PropertyMetadata(0.0));

    /// <summary>Document path.</summary>
    [Category("VectAnim")]
    public string? Source
    {
        get => (string?)GetValue(SourceProperty);
        set => SetValue(SourceProperty, value);
    }

    /// <summary>Whether to play automatically.</summary>
    [Category("VectAnim")]
    public bool AutoPlay
    {
        get => (bool)GetValue(AutoPlayProperty);
        set => SetValue(AutoPlayProperty, value);
    }

    /// <summary>Whether built-in animation is enabled.</summary>
    [Category("VectAnim")]
    public bool AnimationEnabled
    {
        get => (bool)GetValue(AnimationEnabledProperty);
        set => SetValue(AnimationEnabledProperty, value);
    }

    /// <summary>Animation speed multiplier.</summary>
    [Category("VectAnim")]
    public double AnimationSpeed
    {
        get => (double)GetValue(AnimationSpeedProperty);
        set => SetValue(AnimationSpeedProperty, value);
    }

    /// <summary>Render mode.</summary>
    [Category("VectAnim")]
    public VectAnimRenderMode RenderMode
    {
        get => (VectAnimRenderMode)GetValue(RenderModeProperty);
        set => SetValue(RenderModeProperty, value);
    }

    /// <summary>Scale fit mode.</summary>
    [Category("VectAnim")]
    public VectAnimStretch Stretch
    {
        get => (VectAnimStretch)GetValue(StretchProperty);
        set => SetValue(StretchProperty, value);
    }

    /// <summary>Extra zoom.</summary>
    [Category("VectAnim")]
    public double Zoom
    {
        get => (double)GetValue(ZoomProperty);
        set => SetValue(ZoomProperty, value);
    }

    /// <summary>Extra horizontal offset.</summary>
    [Category("VectAnim")]
    public double OffsetX
    {
        get => (double)GetValue(OffsetXProperty);
        set => SetValue(OffsetXProperty, value);
    }

    /// <summary>Extra vertical offset.</summary>
    [Category("VectAnim")]
    public double OffsetY
    {
        get => (double)GetValue(OffsetYProperty);
        set => SetValue(OffsetYProperty, value);
    }

    /// <summary>Whether to respond to mouse interaction.</summary>
    [Category("VectAnim")]
    public bool Interactive
    {
        get => (bool)GetValue(InteractiveProperty);
        set => SetValue(InteractiveProperty, value);
    }

    /// <summary>Validity period of external writes (milliseconds).</summary>
    [Category("VectAnim")]
    public double ExternalWriteTimeout
    {
        get => (double)GetValue(ExternalWriteTimeoutProperty);
        set => SetValue(ExternalWriteTimeoutProperty, value);
    }

    private static void OnSourceChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        var viewer = (VectAnimViewer)d;
        var path = e.NewValue as string;
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        viewer.LoadFromFile(path);
    }

    private static void OnAutoPlayChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        var viewer = (VectAnimViewer)d;
        if ((bool)e.NewValue && viewer.Document is not null)
        {
            viewer.PlayAnimation();
        }
    }

    private static void OnAnimationEnabledChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        var viewer = (VectAnimViewer)d;
        if (!(bool)e.NewValue)
        {
            viewer.PauseAnimation();
        }
    }

    private static void OnRenderModeChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        var viewer = (VectAnimViewer)d;
        viewer.ApplyRenderMode();
        viewer.InvalidateVisual();
    }

    private static object CoerceZoom(DependencyObject d, object baseValue)
    {
        var value = (double)baseValue;
        if (double.IsNaN(value) || double.IsInfinity(value))
        {
            return 1.0;
        }

        return Math.Clamp(value, 0.01, 100);
    }

    #endregion

    #region Events

    /// <summary>A shape was clicked (left button).</summary>
    public static readonly RoutedEvent ShapeClickEvent = EventManager.RegisterRoutedEvent(
        nameof(ShapeClick), RoutingStrategy.Bubble, typeof(EventHandler<VectAnimShapeEventArgs>), typeof(VectAnimViewer));

    /// <summary>A shape was right-clicked.</summary>
    public static readonly RoutedEvent ShapeRightClickEvent = EventManager.RegisterRoutedEvent(
        nameof(ShapeRightClick), RoutingStrategy.Bubble, typeof(EventHandler<VectAnimShapeEventArgs>), typeof(VectAnimViewer));

    /// <summary>The mouse button was pressed on a shape.</summary>
    public static readonly RoutedEvent ShapeMouseDownEvent = EventManager.RegisterRoutedEvent(
        nameof(ShapeMouseDown), RoutingStrategy.Bubble, typeof(EventHandler<VectAnimShapeEventArgs>), typeof(VectAnimViewer));

    /// <summary>The mouse button was released on a shape.</summary>
    public static readonly RoutedEvent ShapeMouseUpEvent = EventManager.RegisterRoutedEvent(
        nameof(ShapeMouseUp), RoutingStrategy.Bubble, typeof(EventHandler<VectAnimShapeEventArgs>), typeof(VectAnimViewer));

    /// <summary>The mouse entered a shape.</summary>
    public static readonly RoutedEvent ShapeMouseEnterEvent = EventManager.RegisterRoutedEvent(
        nameof(ShapeMouseEnter), RoutingStrategy.Bubble, typeof(EventHandler<VectAnimShapeEventArgs>), typeof(VectAnimViewer));

    /// <summary>The mouse left a shape.</summary>
    public static readonly RoutedEvent ShapeMouseLeaveEvent = EventManager.RegisterRoutedEvent(
        nameof(ShapeMouseLeave), RoutingStrategy.Bubble, typeof(EventHandler<VectAnimShapeEventArgs>), typeof(VectAnimViewer));

    /// <summary>A shape was clicked.</summary>
    public event EventHandler<VectAnimShapeEventArgs> ShapeClick
    {
        add => AddHandler(ShapeClickEvent, value);
        remove => RemoveHandler(ShapeClickEvent, value);
    }

    /// <summary>A shape was right-clicked.</summary>
    public event EventHandler<VectAnimShapeEventArgs> ShapeRightClick
    {
        add => AddHandler(ShapeRightClickEvent, value);
        remove => RemoveHandler(ShapeRightClickEvent, value);
    }

    /// <summary>The mouse button was pressed on a shape.</summary>
    public event EventHandler<VectAnimShapeEventArgs> ShapeMouseDown
    {
        add => AddHandler(ShapeMouseDownEvent, value);
        remove => RemoveHandler(ShapeMouseDownEvent, value);
    }

    /// <summary>The mouse button was released on a shape.</summary>
    public event EventHandler<VectAnimShapeEventArgs> ShapeMouseUp
    {
        add => AddHandler(ShapeMouseUpEvent, value);
        remove => RemoveHandler(ShapeMouseUpEvent, value);
    }

    /// <summary>The mouse entered a shape.</summary>
    public event EventHandler<VectAnimShapeEventArgs> ShapeMouseEnter
    {
        add => AddHandler(ShapeMouseEnterEvent, value);
        remove => RemoveHandler(ShapeMouseEnterEvent, value);
    }

    /// <summary>The mouse left a shape.</summary>
    public event EventHandler<VectAnimShapeEventArgs> ShapeMouseLeave
    {
        add => AddHandler(ShapeMouseLeaveEvent, value);
        remove => RemoveHandler(ShapeMouseLeaveEvent, value);
    }

    /// <summary>Document loaded (including validation warnings).</summary>
    public event EventHandler<VectAnimLoadEventArgs>? LoadCompleted;

    /// <summary>Document load failed.</summary>
    public event EventHandler<VectAnimLoadFailedEventArgs>? LoadFailed;

    /// <summary>Runtime warning (missing variable, expression error, and so on).</summary>
    public event EventHandler<VectAnimWarningEventArgs>? WarningRaised;

    /// <summary>A variable value changed (animation or external write).</summary>
    public event EventHandler<VectAnimVariableChangedEventArgs>? VariableChanged;

    /// <summary>Playback state changed.</summary>
    public event EventHandler? PlaybackStateChanged;

    /// <summary>Raised after each frame is rendered, so the host application can collect performance statistics.</summary>
    public event EventHandler? FrameRendered;

    #endregion

    #region Public properties

    /// <summary>Current document; null when nothing is loaded.</summary>
    [Browsable(false)]
    public VectAnimDocument? Document { get; private set; }

    /// <summary>Document source (path or "&lt;string&gt;").</summary>
    [Browsable(false)]
    public string? CurrentSource => _currentSource;

    /// <summary>List of validation issues.</summary>
    [Browsable(false)]
    public IReadOnlyList<ValidationIssue> ValidationIssues => _validationIssues;

    /// <summary>List of runtime warnings.</summary>
    [Browsable(false)]
    public IReadOnlyList<RuntimeWarning> RuntimeWarnings => _runtime.Warnings;

    /// <summary>Whether the animation is playing.</summary>
    [Browsable(false)]
    public bool IsAnimationPlaying => _isPlaying;

    /// <summary>Current animation time (seconds).</summary>
    [Browsable(false)]
    public double AnimationTime => _runtime.Time;

    /// <summary>Timeline duration (seconds).</summary>
    [Browsable(false)]
    public double AnimationDuration => _runtime.TimelineDuration;

    /// <summary>Number of shapes.</summary>
    [Browsable(false)]
    public int ShapeCount => _scene.ShapeCount;

    /// <summary>Names of the defined variables.</summary>
    [Browsable(false)]
    public IReadOnlyCollection<string> VariableNames => _runtime.Variables.Names;

    /// <summary>ID of the most recently hit shape (hover).</summary>
    [Browsable(false)]
    public string? HoveredShapeId => _hoveredShapeId;

    #endregion

    #region Loading

    /// <summary>Loads from a file.</summary>
    public void LoadFromFile(string path)
    {
        try
        {
            var document = VectAnimJson.LoadFromFile(path);
            ApplyDocument(document, path);
        }
        catch (Exception exception)
        {
            RaiseLoadFailed(path, exception);
        }
    }

    /// <summary>Loads from JSON text.</summary>
    public void LoadFromString(string json, string? sourceName = null)
    {
        try
        {
            var document = VectAnimJson.LoadFromString(json);
            ApplyDocument(document, sourceName ?? "<string>");
        }
        catch (Exception exception)
        {
            RaiseLoadFailed(sourceName, exception);
        }
    }

    /// <summary>Loads a document object directly (normalized once).</summary>
    public void LoadFromDocument(VectAnimDocument document, string? sourceName = null)
    {
        if (document is null)
        {
            throw new ArgumentNullException(nameof(document));
        }

        var issues = DocumentValidator.Normalize(document);
        ApplyDocumentCore(document, sourceName ?? "<document>", issues);
    }

    /// <summary>Reloads the current source.</summary>
    public void Reload()
    {
        if (!string.IsNullOrWhiteSpace(_currentSource) && _currentSource != "<string>" && _currentSource != "<document>")
        {
            LoadFromFile(_currentSource);
            return;
        }

        if (Document is not null)
        {
            ApplyDocument(Document, _currentSource);
        }
    }

    /// <summary>Unloads the document.</summary>
    public void Unload()
    {
        PauseAnimation();
        Document = null;
        _currentSource = null;
        _validationIssues.Clear();
        _scene.Load(new VectAnimDocument());
        _runtime.LoadDocument(new VectAnimDocument());
        _externalTimestamps.Clear();
        ApplyRenderMode();
        InvalidateVisual();
    }

    private void ApplyDocument(VectAnimDocument document, string? source)
    {
        var issues = DocumentValidator.Normalize(document);
        ApplyDocumentCore(document, source, issues);
    }

    private void ApplyDocumentCore(VectAnimDocument document, string? source, IReadOnlyList<ValidationIssue> issues)
    {
        Document = document;
        _currentSource = source;
        _validationIssues.Clear();
        _validationIssues.AddRange(issues);
        _externalTimestamps.Clear();
        _hoveredShapeId = null;

        _runtime.LoadDocument(document);
        _scene.Load(document);
        _scene.Update(_runtime.Variables);

        _isPlaying = false;
        UnhookRendering();
        ApplyRenderMode();
        InvalidateMeasure();
        InvalidateVisual();

        LoadCompleted?.Invoke(this, new VectAnimLoadEventArgs(source, _validationIssues));
        foreach (var warning in _runtime.Warnings)
        {
            WarningRaised?.Invoke(this, new VectAnimWarningEventArgs(warning));
        }

        if (AutoPlay && (document.ExpressionAnimations.Count > 0 || document.KeyframeAnimations.Count > 0))
        {
            PlayAnimation();
        }
    }

    private void RaiseLoadFailed(string? source, Exception exception)
    {
        LoadFailed?.Invoke(this, new VectAnimLoadFailedEventArgs(source, exception));
    }

    #endregion

    #region Variable API

    /// <summary>
    /// Sets a variable value (external drive). May be called from any thread.
    /// An external write overrides expression/keyframe animation results for this variable until <see cref="ClearExternal"/>.
    /// </summary>
    public void SetVariable(string name, double value)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return;
        }

        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(() => SetVariable(name, value)));
            return;
        }

        var changed = _runtime.SetVariable(name, value);
        _externalTimestamps[name] = _clock.ElapsedMilliseconds;

        // External writes must recompute the expressions that depend on them (e.g. a TankLevel change drives the level height),
        // otherwise the screen would only update while playing and a static screen would appear stuck.
        var recomputed = _runtime.Recompute();
        if (changed || recomputed)
        {
            UpdateSceneAndInvalidate();
        }

        if (changed)
        {
            VariableChanged?.Invoke(this, new VectAnimVariableChangedEventArgs(name, value));
        }
    }

    /// <summary>Sets multiple variables at once (single redraw). May be called from any thread.</summary>
    public void SetVariables(IEnumerable<KeyValuePair<string, double>> values)
    {
        if (values is null)
        {
            return;
        }

        if (!Dispatcher.CheckAccess())
        {
            var snapshot = values.ToList();
            Dispatcher.BeginInvoke(new Action(() => SetVariables(snapshot)));
            return;
        }

        BeginUpdate();
        try
        {
            var timestamp = _clock.ElapsedMilliseconds;
            foreach (var pair in values)
            {
                if (string.IsNullOrWhiteSpace(pair.Key))
                {
                    continue;
                }

                if (_runtime.SetVariable(pair.Key, pair.Value))
                {
                    VariableChanged?.Invoke(this, new VectAnimVariableChangedEventArgs(pair.Key, pair.Value));
                }

                _externalTimestamps[pair.Key] = timestamp;
            }

            _runtime.Recompute();
        }
        finally
        {
            EndUpdate();
        }
    }

    /// <summary>Reads a variable value; returns 0 when it does not exist.</summary>
    public double GetVariable(string name) => _runtime.GetVariable(name);

    /// <summary>Tries to read a variable value.</summary>
    public bool TryGetVariable(string name, out double value) => _runtime.Variables.TryGet(name, out value);

    /// <summary>Whether the variable is defined.</summary>
    public bool HasVariable(string name) => _runtime.HasVariable(name);

    /// <summary>Clears the external write mark (null clears all) so built-in animation takes over again.</summary>
    public void ClearExternal(string? name = null)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(() => ClearExternal(name)));
            return;
        }

        _runtime.Variables.ClearExternal(name);
        if (name is null)
        {
            _externalTimestamps.Clear();
        }
        else
        {
            _externalTimestamps.Remove(name);
        }

        _runtime.Recompute();
        UpdateSceneAndInvalidate();
    }

    /// <summary>Restores all variables to their defaults and clears the external marks.</summary>
    public void ResetVariables()
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(ResetVariables));
            return;
        }

        _runtime.Variables.Reset();
        _externalTimestamps.Clear();
        _runtime.Recompute();
        UpdateSceneAndInvalidate();
    }

    /// <summary>Whether the variable is currently driven externally (for debugging).</summary>
    public bool IsExternallyDriven(string name) => _runtime.Variables.IsExternal(name);

    /// <summary>Batches multiple changes into a single redraw.</summary>
    public void BeginUpdate()
    {
        _updateDepth++;
    }

    /// <summary>Ends the batched changes.</summary>
    public void EndUpdate()
    {
        if (_updateDepth > 0)
        {
            _updateDepth--;
        }

        if (_updateDepth == 0)
        {
            UpdateSceneAndInvalidate();
        }
    }

    #endregion

    #region Playback control

    /// <summary>Starts (or resumes) built-in animation.</summary>
    public void PlayAnimation()
    {
        if (Document is null || _disposed)
        {
            return;
        }

        if (!AnimationEnabled)
        {
            return;
        }

        if (_isPlaying)
        {
            return;
        }

        _isPlaying = true;
        _lastFrameSeconds = _clock.Elapsed.TotalSeconds;
        HookRendering();
        PlaybackStateChanged?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>Pauses the animation (time stops advancing).</summary>
    public void PauseAnimation()
    {
        if (!_isPlaying)
        {
            return;
        }

        _isPlaying = false;
        UnhookRendering();
        PlaybackStateChanged?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>Stops the animation and returns to 0 seconds.</summary>
    public void StopAnimation()
    {
        PauseAnimation();
        _runtime.Stop();
        UpdateSceneAndInvalidate();
    }

    /// <summary>Seeks to the given time (seconds).</summary>
    public void SeekAnimation(double seconds)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(() => SeekAnimation(seconds)));
            return;
        }

        _runtime.Seek(seconds);
        UpdateSceneAndInvalidate();
    }

    #endregion

    #region Rendering

    /// <summary>Current view matrix (canvas coordinates -> control coordinates).</summary>
    public Matrix GetViewMatrix()
    {
        var canvas = Document?.Canvas ?? new CanvasDefinition();
        var width = ActualWidth;
        var height = ActualHeight;
        if (width <= 0 || height <= 0 || canvas.Width <= 0 || canvas.Height <= 0)
        {
            return Matrix.Identity;
        }

        double scaleX = 1;
        double scaleY = 1;
        double offsetX = 0;
        double offsetY = 0;

        switch (Stretch)
        {
            case VectAnimStretch.None:
                break;

            case VectAnimStretch.Uniform:
                scaleX = scaleY = Math.Min(width / canvas.Width, height / canvas.Height);
                offsetX = (width - (canvas.Width * scaleX)) / 2;
                offsetY = (height - (canvas.Height * scaleY)) / 2;
                break;

            case VectAnimStretch.UniformToFill:
                scaleX = scaleY = Math.Max(width / canvas.Width, height / canvas.Height);
                offsetX = (width - (canvas.Width * scaleX)) / 2;
                offsetY = (height - (canvas.Height * scaleY)) / 2;
                break;

            case VectAnimStretch.Fill:
                scaleX = width / canvas.Width;
                scaleY = height / canvas.Height;
                break;
        }

        // Target semantics: p' = p * Scale * Translate (scale first, then translate).
        var matrix = Matrix.Identity;
        matrix.Scale(scaleX, scaleY);

        if (Zoom != 1)
        {
            matrix.ScaleAt(Zoom, Zoom, width / 2, height / 2);
        }

        if (offsetX != 0 || offsetY != 0 || OffsetX != 0 || OffsetY != 0)
        {
            matrix.Translate(offsetX + OffsetX, offsetY + OffsetY);
        }

        return matrix;
    }

    /// <summary>Control coordinates -> canvas coordinates.</summary>
    public Point ToCanvasPoint(Point controlPoint)
    {
        var matrix = GetViewMatrix();
        if (!matrix.HasInverse)
        {
            return controlPoint;
        }

        matrix.Invert();
        return matrix.Transform(controlPoint);
    }

    /// <summary>Hit testing: returns the ID of the topmost shape at the given control coordinates.</summary>
    public string? HitTestShape(Point controlPoint)
    {
        var canvasPoint = ToCanvasPoint(controlPoint);
        return _scene.HitTest(canvasPoint)?.Source.Id;
    }

    /// <inheritdoc />
    protected override int VisualChildrenCount => _visuals?.Count ?? 0;

    /// <inheritdoc />
    protected override Visual GetVisualChild(int index)
    {
        if (_visuals is null || index < 0 || index >= _visuals.Count)
        {
            throw new ArgumentOutOfRangeException(nameof(index));
        }

        return _visuals[index];
    }

    /// <inheritdoc />
    protected override Size MeasureOverride(Size availableSize)
    {
        var canvas = Document?.Canvas;
        if (canvas is null)
        {
            return new Size(0, 0);
        }

        var width = double.IsInfinity(availableSize.Width) ? canvas.Width : Math.Min(canvas.Width, availableSize.Width);
        var height = double.IsInfinity(availableSize.Height) ? canvas.Height : Math.Min(canvas.Height, availableSize.Height);
        return new Size(Math.Max(0, width), Math.Max(0, height));
    }

    /// <inheritdoc />
    protected override void OnRender(DrawingContext drawingContext)
    {
        base.OnRender(drawingContext);

        // Transparent background so empty areas still receive mouse events.
        drawingContext.DrawRectangle(Brushes.Transparent, null, new Rect(RenderSize));

        if (Document is null)
        {
            return;
        }

        var view = GetViewMatrix();
        var hasView = !view.IsIdentity;

        if (RenderMode == VectAnimRenderMode.Drawing)
        {
            if (hasView)
            {
                drawingContext.PushTransform(new MatrixTransform(view));
            }

            _scene.Render(drawingContext);

            if (hasView)
            {
                drawingContext.Pop();
            }
        }
        else
        {
            // In Shapes mode the background is drawn here; shapes are drawn by Path visuals.
            var background = _scene.GetBackgroundBrush();
            if (background is not null)
            {
                var canvas = Document.Canvas;
                var rect = new Rect(0, 0, canvas.Width, canvas.Height);
                var transformed = Rect.Transform(rect, view);
                drawingContext.DrawRectangle(background, null, transformed);
            }

            SyncShapeVisuals(view);
        }

        FrameRendered?.Invoke(this, EventArgs.Empty);
    }

    private void SyncShapeVisuals(Matrix view)
    {
        if (_visuals is null)
        {
            return;
        }

        var states = _scene.States;
        EnsureShapeVisualCount(states.Count);

        for (var index = 0; index < states.Count; index++)
        {
            var state = states[index];
            var path = _shapeVisuals[index];
            var transform = _shapeTransforms[index];

            path.Data = state.Geometry;
            path.Fill = state.FillBrush;
            path.Stroke = state.StrokePen?.Brush;
            path.StrokeThickness = state.StrokePen?.Thickness ?? 0;
            path.Opacity = state.Opacity;
            path.Visibility = state.IsVisible ? Visibility.Visible : Visibility.Collapsed;

            var shapeMatrix = state.Transform.ToMatrix();
            if (!view.IsIdentity)
            {
                shapeMatrix.Append(view);
            }

            transform.Matrix = shapeMatrix;
            path.RenderTransform = transform;
        }
    }

    private void EnsureShapeVisualCount(int count)
    {
        if (_visuals is null)
        {
            return;
        }

        while (_shapeVisuals.Count < count)
        {
            var path = new ShapePath
            {
                IsHitTestVisible = false,
                SnapsToDevicePixels = false,
                StrokeLineJoin = PenLineJoin.Miter,
                StrokeMiterLimit = 4,
            };
            var transform = new MatrixTransform();
            path.RenderTransform = transform;
            _shapeVisuals.Add(path);
            _shapeTransforms.Add(transform);
            _visuals.Add(path);
        }

        while (_shapeVisuals.Count > count)
        {
            var index = _shapeVisuals.Count - 1;
            _visuals.Remove(_shapeVisuals[index]);
            _shapeVisuals.RemoveAt(index);
            _shapeTransforms.RemoveAt(index);
        }
    }

    private void ApplyRenderMode()
    {
        if (RenderMode == VectAnimRenderMode.Shapes)
        {
            _visuals ??= new VisualCollection(this);
            EnsureShapeVisualCount(_scene.States.Count);
        }
        else if (_visuals is not null)
        {
            _visuals.Clear();
            _shapeVisuals.Clear();
            _shapeTransforms.Clear();
        }
    }

    private void UpdateSceneAndInvalidate()
    {
        if (_updateDepth > 0)
        {
            _invalidatePending = true;
            return;
        }

        if (_scene.Update(_runtime.Variables))
        {
            if (RenderMode == VectAnimRenderMode.Shapes)
            {
                SyncShapeVisuals(GetViewMatrix());
            }

            InvalidateVisual();
        }
        else if (_invalidatePending)
        {
            _invalidatePending = false;
            InvalidateVisual();
        }
    }

    #endregion

    #region Animation loop

    private void HookRendering()
    {
        if (_renderingHooked)
        {
            return;
        }

        CompositionTarget.Rendering += OnCompositionTargetRendering;
        _renderingHooked = true;
    }

    private void UnhookRendering()
    {
        if (!_renderingHooked)
        {
            return;
        }

        CompositionTarget.Rendering -= OnCompositionTargetRendering;
        _renderingHooked = false;
    }

    private void OnCompositionTargetRendering(object? sender, EventArgs e)
    {
        if (!_isPlaying || _disposed)
        {
            return;
        }

        var now = _clock.Elapsed.TotalSeconds;
        var delta = now - _lastFrameSeconds;
        _lastFrameSeconds = now;
        if (delta <= 0)
        {
            return;
        }

        var speed = AnimationSpeed;
        if (speed <= 0 || double.IsNaN(speed))
        {
            speed = 1;
        }

        ExpireExternalWrites();

        var changed = _runtime.Advance(delta * speed);
        if (changed)
        {
            UpdateSceneAndInvalidate();
        }
    }

    private void ExpireExternalWrites()
    {
        var timeout = ExternalWriteTimeout;
        if (timeout <= 0 || _externalTimestamps.Count == 0)
        {
            return;
        }

        var now = _clock.ElapsedMilliseconds;
        List<string>? expired = null;
        foreach (var pair in _externalTimestamps)
        {
            if (now - pair.Value > timeout)
            {
                (expired ??= new List<string>()).Add(pair.Key);
            }
        }

        if (expired is null)
        {
            return;
        }

        foreach (var name in expired)
        {
            _runtime.Variables.ClearExternal(name);
            _externalTimestamps.Remove(name);
        }
    }

    #endregion

    #region Input

    /// <inheritdoc />
    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (!Interactive || Document is null)
        {
            return;
        }

        var point = e.GetPosition(this);
        var hit = _scene.HitTest(ToCanvasPoint(point));

        if (hit is null)
        {
            if (_hoveredShapeId is not null)
            {
                var previousId = _hoveredShapeId;
                var previousName = _scene.GetState(previousId)?.Source.Name ?? previousId;
                _hoveredShapeId = null;
                Cursor = Cursors.Arrow;
                RaiseEvent(new VectAnimShapeEventArgs(ShapeMouseLeaveEvent, previousId, previousName, ToCanvasPoint(point), point, null));
            }

            return;
        }

        if (_hoveredShapeId != hit.Source.Id)
        {
            if (_hoveredShapeId is not null)
            {
                var previousId = _hoveredShapeId;
                var previousName = _scene.GetState(previousId)?.Source.Name ?? previousId;
                RaiseEvent(new VectAnimShapeEventArgs(ShapeMouseLeaveEvent, previousId, previousName, ToCanvasPoint(point), point, null));
            }

            _hoveredShapeId = hit.Source.Id;
            Cursor = Cursors.Hand;
            RaiseEvent(new VectAnimShapeEventArgs(ShapeMouseEnterEvent, hit.Source.Id, hit.Source.Name, ToCanvasPoint(point), point, null));
        }
    }

    /// <inheritdoc />
    protected override void OnMouseLeave(MouseEventArgs e)
    {
        base.OnMouseLeave(e);
        if (_hoveredShapeId is null)
        {
            return;
        }

        var point = e.GetPosition(this);
        var previousId = _hoveredShapeId;
        var previousName = _scene.GetState(previousId)?.Source.Name ?? previousId;
        _hoveredShapeId = null;
        Cursor = Cursors.Arrow;
        RaiseEvent(new VectAnimShapeEventArgs(ShapeMouseLeaveEvent, previousId, previousName, ToCanvasPoint(point), point, null));
    }

    /// <inheritdoc />
    protected override void OnMouseLeftButtonDown(MouseButtonEventArgs e)
    {
        base.OnMouseLeftButtonDown(e);
        if (!Interactive || Document is null)
        {
            return;
        }

        var point = e.GetPosition(this);
        var hit = _scene.HitTest(ToCanvasPoint(point));
        if (hit is null)
        {
            return;
        }

        RaiseEvent(new VectAnimShapeEventArgs(ShapeMouseDownEvent, hit.Source.Id, hit.Source.Name, ToCanvasPoint(point), point, MouseButton.Left));
    }

    /// <inheritdoc />
    protected override void OnMouseLeftButtonUp(MouseButtonEventArgs e)
    {
        base.OnMouseLeftButtonUp(e);
        if (!Interactive || Document is null)
        {
            return;
        }

        var point = e.GetPosition(this);
        var hit = _scene.HitTest(ToCanvasPoint(point));
        if (hit is null)
        {
            return;
        }

        RaiseEvent(new VectAnimShapeEventArgs(ShapeMouseUpEvent, hit.Source.Id, hit.Source.Name, ToCanvasPoint(point), point, MouseButton.Left));
        RaiseEvent(new VectAnimShapeEventArgs(ShapeClickEvent, hit.Source.Id, hit.Source.Name, ToCanvasPoint(point), point, MouseButton.Left));
    }

    /// <inheritdoc />
    protected override void OnMouseRightButtonUp(MouseButtonEventArgs e)
    {
        base.OnMouseRightButtonUp(e);
        if (!Interactive || Document is null)
        {
            return;
        }

        var point = e.GetPosition(this);
        var hit = _scene.HitTest(ToCanvasPoint(point));
        if (hit is null)
        {
            return;
        }

        RaiseEvent(new VectAnimShapeEventArgs(ShapeRightClickEvent, hit.Source.Id, hit.Source.Name, ToCanvasPoint(point), point, MouseButton.Right));
    }

    #endregion

    #region Offscreen rendering

    /// <summary>
    /// Renders the current view to a bitmap (for printing, reports and thumbnails).
    /// </summary>
    /// <param name="scale">Scale factor; 1 means the canvas's original size.</param>
    public BitmapSource RenderToBitmap(double scale = 1)
    {
        var canvas = Document?.Canvas ?? new CanvasDefinition();
        var width = Math.Max(1, (int)Math.Round(canvas.Width * scale));
        var height = Math.Max(1, (int)Math.Round(canvas.Height * scale));

        var visual = new DrawingVisual();
        using (var context = visual.RenderOpen())
        {
            context.PushTransform(new ScaleTransform(scale, scale));
            _scene.Render(context);
            context.Pop();
        }

        var bitmap = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(visual);
        bitmap.Freeze();
        return bitmap;
    }

    #endregion

    /// <inheritdoc />
    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _isPlaying = false;
        UnhookRendering();
        _visuals?.Clear();
        _shapeVisuals.Clear();
        _shapeTransforms.Clear();
        GC.SuppressFinalize(this);
    }
}
