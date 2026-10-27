using VectAnim.Wpf.Localization;

namespace VectAnim.Wpf.Expressions;

/// <summary>Expression function definition.</summary>
public sealed class ExpressionFunction
{
    internal ExpressionFunction(string name, int minArgs, int maxArgs, Func<double[], double> invoke, string description)
    {
        Name = name;
        MinArgs = minArgs;
        MaxArgs = maxArgs;
        Invoke = invoke;
        Description = description;
    }

    /// <summary>Function name (lowercase).</summary>
    public string Name { get; }

    /// <summary>Minimum number of arguments.</summary>
    public int MinArgs { get; }

    /// <summary>Maximum number of arguments.</summary>
    public int MaxArgs { get; }

    /// <summary>Description.</summary>
    public string Description { get; }

    internal Func<double[], double> Invoke { get; }
}

/// <summary>
/// Whitelist of expression functions.
///
/// An industrial site must not expose arbitrary CLR methods to description files (that would amount to remote code execution),
/// so only pure math functions are provided here; trigonometric functions take degrees, matching the editor.
/// </summary>
public static class ExpressionFunctions
{
    private const double DegreesPerRadian = 180.0 / Math.PI;
    private const double RadiansPerDegree = Math.PI / 180.0;

    private static readonly Dictionary<string, ExpressionFunction> Functions =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["sin"] = new("sin", 1, 1, a => Math.Sin(a[0] * RadiansPerDegree), Strings.T("Functions.Sin")),
            ["cos"] = new("cos", 1, 1, a => Math.Cos(a[0] * RadiansPerDegree), Strings.T("Functions.Cos")),
            ["tan"] = new("tan", 1, 1, a => Math.Tan(a[0] * RadiansPerDegree), Strings.T("Functions.Tan")),
            ["asin"] = new("asin", 1, 1, a => Math.Asin(Math.Clamp(a[0], -1, 1)) * DegreesPerRadian, Strings.T("Functions.Asin")),
            ["acos"] = new("acos", 1, 1, a => Math.Acos(Math.Clamp(a[0], -1, 1)) * DegreesPerRadian, Strings.T("Functions.Acos")),
            ["atan"] = new("atan", 1, 1, a => Math.Atan(a[0]) * DegreesPerRadian, Strings.T("Functions.Atan")),
            ["atan2"] = new("atan2", 2, 2, a => Math.Atan2(a[0], a[1]) * DegreesPerRadian, Strings.T("Functions.Atan2")),
            ["sqrt"] = new("sqrt", 1, 1, a => Math.Sqrt(Math.Max(0, a[0])), Strings.T("Functions.Sqrt")),
            ["abs"] = new("abs", 1, 1, a => Math.Abs(a[0]), Strings.T("Functions.Abs")),
            ["min"] = new("min", 1, 8, a => a.Min(), Strings.T("Functions.Min")),
            ["max"] = new("max", 1, 8, a => a.Max(), Strings.T("Functions.Max")),
            ["pow"] = new("pow", 2, 2, a => Math.Pow(a[0], a[1]), Strings.T("Functions.Pow")),
            ["floor"] = new("floor", 1, 1, a => Math.Floor(a[0]), Strings.T("Functions.Floor")),
            ["ceil"] = new("ceil", 1, 1, a => Math.Ceiling(a[0]), Strings.T("Functions.Ceil")),
            ["round"] = new("round", 1, 2, a =>
            {
                var digits = a.Length > 1 ? (int)Math.Truncate(a[1]) : 0;
                digits = Math.Clamp(digits, -8, 8);
                var factor = Math.Pow(10, digits);
                return Math.Floor((a[0] * factor) + 0.5) / factor;
            }, Strings.T("Functions.Round")),
            ["trunc"] = new("trunc", 1, 1, a => Math.Truncate(a[0]), Strings.T("Functions.Trunc")),
            ["sign"] = new("sign", 1, 1, a => Math.Sign(a[0]), Strings.T("Functions.Sign")),
            ["exp"] = new("exp", 1, 1, a => Math.Exp(a[0]), Strings.T("Functions.Exp")),
            ["ln"] = new("ln", 1, 1, a => Math.Log(Math.Max(1e-12, a[0])), Strings.T("Functions.Ln")),
            ["log"] = new("log", 1, 2, a =>
            {
                var value = Math.Log(Math.Max(1e-12, a[0]));
                if (a.Length <= 1)
                {
                    return value;
                }

                var basis = a[1];
                return basis > 0 && Math.Abs(basis - 1) > double.Epsilon ? value / Math.Log(basis) : 0;
            }, Strings.T("Functions.Log")),
            ["log10"] = new("log10", 1, 1, a => Math.Log10(Math.Max(1e-12, a[0])), Strings.T("Functions.Log10")),
            ["clamp"] = new("clamp", 3, 3, a => Math.Min(Math.Max(a[0], a[1]), a[2]), Strings.T("Functions.Clamp")),
            ["lerp"] = new("lerp", 3, 3, a => a[0] + ((a[1] - a[0]) * a[2]), Strings.T("Functions.Lerp")),
            ["mod"] = new("mod", 2, 2, a => EuclideanMod(a[0], a[1]), Strings.T("Functions.Mod")),
            ["deg"] = new("deg", 1, 1, a => a[0] * DegreesPerRadian, Strings.T("Functions.Deg")),
            ["rad"] = new("rad", 1, 1, a => a[0] * RadiansPerDegree, Strings.T("Functions.Rad")),
            ["if"] = new("if", 3, 3, a => a[0] != 0 ? a[1] : a[2], Strings.T("Functions.If")),
            ["pi"] = new("pi", 0, 0, _ => Math.PI, Strings.T("Functions.Pi")),
        };

    private static readonly Dictionary<string, double> Constants =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["pi"] = Math.PI,
            ["e"] = Math.E,
            ["true"] = 1,
            ["false"] = 0,
        };

    /// <summary>All function names (lowercase, sorted), for documentation and diagnostics.</summary>
    public static IReadOnlyList<string> Names => Functions.Keys.OrderBy(name => name, StringComparer.Ordinal).ToList();

    /// <summary>Looks up a function by name.</summary>
    public static ExpressionFunction? Find(string name) =>
        Functions.TryGetValue(name, out var function) ? function : null;

    /// <summary>Looks up a constant (pi / e / true / false).</summary>
    public static bool TryGetConstant(string name, out double value) => Constants.TryGetValue(name, out value);

    /// <summary>Euclidean modulo: the result takes the sign of the divisor, e.g. mod(-30, 360) = 330.</summary>
    public static double EuclideanMod(double value, double divisor)
    {
        if (divisor == 0)
        {
            return 0;
        }

        var remainder = value % divisor;
        return remainder < 0 ? remainder + Math.Abs(divisor) : remainder;
    }
}
