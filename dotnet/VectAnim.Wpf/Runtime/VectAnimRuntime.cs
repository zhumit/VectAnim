using VectAnim.Wpf.Animation;
using VectAnim.Wpf.Expressions;
using VectAnim.Wpf.Localization;
using VectAnim.Wpf.Model;

namespace VectAnim.Wpf.Runtime;

/// <summary>Runtime warning kind.</summary>
public enum RuntimeWarningKind
{
    /// <summary>A reference to an undefined variable.</summary>
    MissingVariable,

    /// <summary>The expression cannot be compiled.</summary>
    ExpressionError,

    /// <summary>Cyclic dependency between expression animations.</summary>
    Cycle,

    /// <summary>Invalid keyframe animation data.</summary>
    Keyframe,

    /// <summary>Invalid document structure.</summary>
    Document,
}

/// <summary>Runtime warning.</summary>
public sealed class RuntimeWarning
{
    internal RuntimeWarning(RuntimeWarningKind kind, string message, string? target = null)
    {
        Kind = kind;
        Message = message;
        Target = target;
    }

    /// <summary>Kind.</summary>
    public RuntimeWarningKind Kind { get; }

    /// <summary>Message.</summary>
    public string Message { get; }

    /// <summary>Related variable or shape.</summary>
    public string? Target { get; }

    /// <inheritdoc />
    public override string ToString() => $"[{Kind}] {Message}";
}

/// <summary>
/// VectAnim runtime: variable table + expression animations + keyframe animations + time advance.
///
/// Decoupled from rendering: it only computes the current value of each variable, which the rendering layer reads through <see cref="VariableStore"/>.
/// Access is scheduled by the hosting control; this type performs no synchronization itself (to avoid locking on every frame).
/// </summary>
public sealed class VectAnimRuntime
{
    private readonly List<ExpressionTrack> _expressionTracks = new();
    private readonly List<KeyframeAnimationDefinition> _keyframeTracks = new();
    private readonly List<RuntimeWarning> _warnings = new();
    private readonly HashSet<string> _reportedMissing = new(StringComparer.Ordinal);
    private VectAnimDocument _document = new();
    private double _time;
    private bool _playing;

    /// <summary>Creates a runtime.</summary>
    public VectAnimRuntime()
    {
    }

    /// <summary>Creates a runtime and loads the document.</summary>
    public VectAnimRuntime(VectAnimDocument document) => LoadDocument(document);

    /// <summary>Variable store.</summary>
    public VariableStore Variables { get; } = new();

    /// <summary>Current document.</summary>
    public VectAnimDocument Document => _document;

    /// <summary>Runtime warnings (read-only).</summary>
    public IReadOnlyList<RuntimeWarning> Warnings => _warnings;

    /// <summary>Current animation time in seconds.</summary>
    public double Time => _time;

    /// <summary>Whether playback is running.</summary>
    public bool IsPlaying => _playing;

    /// <summary>Number of expression animations.</summary>
    public int ExpressionCount => _expressionTracks.Count;

    /// <summary>Number of keyframe animations.</summary>
    public int KeyframeCount => _keyframeTracks.Count;

    /// <summary>Timeline duration (the time of the last keyframe; returns 0 when there are no keyframes).</summary>
    public double TimelineDuration
    {
        get
        {
            var duration = KeyframeSampler.LongestDuration(_keyframeTracks);
            return duration > 0 ? duration : 0;
        }
    }

    /// <summary>Loads a document: rebuilds the variable table and animation tracks, then immediately computes one frame.</summary>
    public void LoadDocument(VectAnimDocument document)
    {
        _document = document ?? throw new ArgumentNullException(nameof(document));
        _warnings.Clear();
        _reportedMissing.Clear();
        _expressionTracks.Clear();
        _keyframeTracks.Clear();
        Variables.Clear();
        _time = 0;
        _playing = false;

        foreach (var variable in document.Variables)
        {
            if (string.IsNullOrWhiteSpace(variable.Name))
            {
                _warnings.Add(new RuntimeWarning(RuntimeWarningKind.Document, Strings.T("Runtime.UnnamedVariable")));
                continue;
            }

            if (Variables.Contains(variable.Name))
            {
                _warnings.Add(new RuntimeWarning(
                    RuntimeWarningKind.Document,
                    Strings.T("Runtime.DuplicateVariable", variable.Name),
                    variable.Name));
                continue;
            }

            Variables.Define(variable.Name, variable.DefaultValue);
        }

        // Expression animations: compile + dependency topological sort
        foreach (var definition in document.ExpressionAnimations)
        {
            if (string.IsNullOrWhiteSpace(definition.TargetVariable))
            {
                _warnings.Add(new RuntimeWarning(RuntimeWarningKind.Document, Strings.T("Runtime.ExpressionMissingTarget")));
                continue;
            }

            if (!Variables.Contains(definition.TargetVariable))
            {
                Variables.Define(definition.TargetVariable, 0);
                _warnings.Add(new RuntimeWarning(
                    RuntimeWarningKind.MissingVariable,
                    Strings.T("Runtime.ExpressionTargetCreated", definition.TargetVariable),
                    definition.TargetVariable));
            }

            var track = new ExpressionTrack(definition);
            if (ExpressionCompiler.TryCompile(definition.Expression, out var compiled, out var error))
            {
                track.Compiled = compiled;
                foreach (var name in compiled!.Variables)
                {
                    if (!Variables.Contains(name) && !_reportedMissing.Contains(name))
                    {
                        _reportedMissing.Add(name);
                        _warnings.Add(new RuntimeWarning(
                            RuntimeWarningKind.MissingVariable,
                            Strings.T("Runtime.ExpressionUndefinedVariable", name),
                            name));
                    }
                }
            }
            else
            {
                _warnings.Add(new RuntimeWarning(
                    RuntimeWarningKind.ExpressionError,
                    Strings.T("Runtime.ExpressionCompileFailed", definition.Expression, error ?? string.Empty),
                    definition.TargetVariable));
            }

            _expressionTracks.Add(track);
        }

        SortExpressionTracks();

        foreach (var definition in document.KeyframeAnimations)
        {
            if (definition.Enabled == false)
            {
                continue;
            }

            if (string.IsNullOrWhiteSpace(definition.TargetVariable))
            {
                _warnings.Add(new RuntimeWarning(RuntimeWarningKind.Keyframe, Strings.T("Runtime.KeyframeMissingTarget", definition.Name)));
                continue;
            }

            if (!Variables.Contains(definition.TargetVariable))
            {
                Variables.Define(definition.TargetVariable, 0);
                _warnings.Add(new RuntimeWarning(
                    RuntimeWarningKind.MissingVariable,
                    Strings.T("Runtime.KeyframeTargetCreated", definition.TargetVariable),
                    definition.TargetVariable));
            }

            if (definition.Keyframes.Count == 0)
            {
                _warnings.Add(new RuntimeWarning(
                    RuntimeWarningKind.Keyframe,
                    Strings.T("Runtime.KeyframeNoFrames", definition.Name),
                    definition.TargetVariable));
                continue;
            }

            _keyframeTracks.Add(definition);
        }

        // Compute the first frame immediately so the driven state is shown right after loading
        Recompute();
    }

    /// <summary>Orders expression animations by dependency (avoids the one-frame delay caused by "read before compute").</summary>
    private void SortExpressionTracks()
    {
        var byTarget = new Dictionary<string, ExpressionTrack>(StringComparer.Ordinal);
        foreach (var track in _expressionTracks)
        {
            byTarget[track.Definition.TargetVariable] = track;
        }

        var visited = new HashSet<string>(StringComparer.Ordinal);
        var visiting = new HashSet<string>(StringComparer.Ordinal);
        var ordered = new List<ExpressionTrack>(_expressionTracks.Count);

        void Visit(ExpressionTrack track)
        {
            var name = track.Definition.TargetVariable;
            if (visited.Contains(name))
            {
                return;
            }

            if (!visiting.Add(name))
            {
                _warnings.Add(new RuntimeWarning(RuntimeWarningKind.Cycle, Strings.T("Runtime.ExpressionCycle", name), name));
                return;
            }

            foreach (var dependency in track.Compiled?.Variables ?? Array.Empty<string>())
            {
                if (byTarget.TryGetValue(dependency, out var dependencyTrack) && !ReferenceEquals(dependencyTrack, track))
                {
                    Visit(dependencyTrack);
                }
            }

            visiting.Remove(name);
            visited.Add(name);
            ordered.Add(track);
        }

        foreach (var track in _expressionTracks)
        {
            Visit(track);
        }

        _expressionTracks.Clear();
        _expressionTracks.AddRange(ordered);
    }

    /// <summary>Starts playback.</summary>
    public void Play() => _playing = true;

    /// <summary>Pauses (time stops accumulating).</summary>
    public void Pause() => _playing = false;

    /// <summary>Stops and rewinds to 0 seconds.</summary>
    public void Stop()
    {
        _playing = false;
        _time = 0;
        Recompute();
    }

    /// <summary>Seeks to the specified time in seconds.</summary>
    public void Seek(double seconds)
    {
        _time = Math.Max(0, seconds);
        Recompute();
    }

    /// <summary>
    /// Advances one frame.
    /// </summary>
    /// <param name="deltaSeconds">Seconds since the previous frame; clamped to 0..1 internally to avoid a time jump after a long stall.</param>
    /// <returns>Whether any variable value changed (the rendering layer uses this to decide whether to redraw).</returns>
    public bool Advance(double deltaSeconds)
    {
        if (_playing && deltaSeconds > 0)
        {
            _time += Math.Min(deltaSeconds, 1.0);
        }

        return Recompute();
    }

    /// <summary>Recomputes all built-in animation variables.</summary>
    /// <returns>Whether any variable changed.</returns>
    public bool Recompute()
    {
        Variables.Time = _time;
        var changed = false;

        foreach (var track in _expressionTracks)
        {
            if (!track.Definition.Enabled || track.Compiled is null)
            {
                continue;
            }

            var target = track.Definition.TargetVariable;
            if (Variables.IsExternal(target))
            {
                continue;
            }

            var value = track.Compiled.Evaluate(Variables);
            if (track.Definition.Wrap is { } wrap && wrap > 0)
            {
                value = ExpressionFunctions.EuclideanMod(value, wrap);
            }

            changed |= Variables.SetInternal(target, value);
        }

        foreach (var track in _keyframeTracks)
        {
            var target = track.TargetVariable;
            if (Variables.IsExternal(target))
            {
                continue;
            }

            var sampled = KeyframeSampler.Sample(track.Keyframes, _time, track.Loop, track.LoopDelay ?? 0);
            if (sampled.HasValue)
            {
                changed |= Variables.SetInternal(target, sampled.Value);
            }
        }

        return changed;
    }

    /// <summary>Writes a variable (externally driven).</summary>
    /// <returns>Whether the value changed.</returns>
    public bool SetVariable(string name, double value) => Variables.Set(name, value, external: true);

    /// <summary>Writes multiple variables (externally driven).</summary>
    /// <returns>Whether any value changed.</returns>
    public bool SetVariables(IEnumerable<KeyValuePair<string, double>> values)
    {
        var changed = false;
        foreach (var pair in values)
        {
            changed |= Variables.Set(pair.Key, pair.Value, external: true);
        }

        return changed;
    }

    /// <summary>Reads a variable value.</summary>
    public double GetVariable(string name) => Variables.Get(name);

    /// <summary>Whether the variable is defined.</summary>
    public bool HasVariable(string name) => Variables.Contains(name);

    private sealed class ExpressionTrack
    {
        public ExpressionTrack(ExpressionAnimationDefinition definition) => Definition = definition;

        public ExpressionAnimationDefinition Definition { get; }

        public CompiledExpression? Compiled { get; set; }
    }
}
