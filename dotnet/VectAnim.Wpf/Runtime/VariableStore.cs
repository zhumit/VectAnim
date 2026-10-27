using VectAnim.Wpf.Expressions;

namespace VectAnim.Wpf.Runtime;

/// <summary>
/// Variable store: keeps current values, default values and "externally written" flags.
///
/// External-write priority: variables written by the business layer (PLC / serial port / ViewModel) are marked as externally driven,
/// and built-in animations (expressions / keyframes) no longer overwrite them until <see cref="ClearExternal"/> is called or the store is reset.
/// </summary>
public sealed class VariableStore : IExpressionContext
{
    private readonly Dictionary<string, double> _values = new(StringComparer.Ordinal);
    private readonly Dictionary<string, double> _defaults = new(StringComparer.Ordinal);
    private readonly HashSet<string> _external = new(StringComparer.Ordinal);

    /// <summary>Animation time in seconds, written by the runtime before evaluation.</summary>
    public double Time { get; internal set; }

    /// <summary>Variable names (snapshot).</summary>
    public IReadOnlyCollection<string> Names => _values.Keys.ToList();

    /// <summary>Number of variables.</summary>
    public int Count => _values.Count;

    /// <summary>Clears all variables.</summary>
    internal void Clear()
    {
        _values.Clear();
        _defaults.Clear();
        _external.Clear();
        Time = 0;
    }

    /// <summary>Defines a variable (overwrites an existing definition and resets it to the default value).</summary>
    internal void Define(string name, double defaultValue)
    {
        _defaults[name] = defaultValue;
        _values[name] = defaultValue;
        _external.Remove(name);
    }

    /// <summary>Whether the variable is defined.</summary>
    public bool Contains(string name) => _values.ContainsKey(name);

    /// <summary>Reads a variable value; returns 0 when it does not exist.</summary>
    public double Get(string name) => _values.TryGetValue(name, out var value) ? value : 0;

    /// <summary>Tries to read a variable value.</summary>
    public bool TryGet(string name, out double value) => _values.TryGetValue(name, out value);

    /// <summary>Default value of a variable; returns 0 when it does not exist.</summary>
    public double GetDefault(string name) => _defaults.TryGetValue(name, out var value) ? value : 0;

    /// <summary>Whether the variable is driven by an external write.</summary>
    public bool IsExternal(string name) => _external.Contains(name);

    /// <summary>Writes a variable value. When <paramref name="external"/> is true the variable is marked as externally driven.</summary>
    /// <returns>Whether the value changed.</returns>
    internal bool Set(string name, double value, bool external)
    {
        if (double.IsNaN(value) || double.IsInfinity(value))
        {
            return false;
        }

        var changed = !_values.TryGetValue(name, out var current) || !current.Equals(value);
        _values[name] = value;
        if (external)
        {
            _external.Add(name);
        }

        return changed;
    }

    /// <summary>Writes a value computed by a built-in animation (not marked as externally driven).</summary>
    internal bool SetInternal(string name, double value)
    {
        if (!_values.TryGetValue(name, out var current) || !current.Equals(value))
        {
            _values[name] = value;
            return true;
        }

        return false;
    }

    /// <summary>Clears the external-write flag.</summary>
    public void ClearExternal(string? name = null)
    {
        if (name is null)
        {
            _external.Clear();
        }
        else
        {
            _external.Remove(name);
        }
    }

    /// <summary>Clears all external flags and restores the default values.</summary>
    public void Reset()
    {
        _values.Clear();
        foreach (var pair in _defaults)
        {
            _values[pair.Key] = pair.Value;
        }

        _external.Clear();
        Time = 0;
    }

    /// <summary>Restores a single variable to its default value (keeps the external flag).</summary>
    public void ResetVariable(string name)
    {
        if (_defaults.TryGetValue(name, out var value))
        {
            _values[name] = value;
        }
    }

    /// <inheritdoc />
    public bool TryGetVariable(string name, out double value) => _values.TryGetValue(name, out value);
}
