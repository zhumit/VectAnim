using System.Collections.Concurrent;
using VectAnim.Wpf.Localization;

namespace VectAnim.Wpf.Expressions;

/// <summary>A compiled expression: evaluated through a closure tree, with no reflection and no dynamic code generation.</summary>
public sealed class CompiledExpression
{
    private readonly Func<IExpressionContext, double> _evaluator;

    internal CompiledExpression(string source, Func<IExpressionContext, double> evaluator, IReadOnlyList<string> variables, bool usesTime)
    {
        Source = source;
        _evaluator = evaluator;
        Variables = variables;
        UsesTime = usesTime;
    }

    /// <summary>Original expression text.</summary>
    public string Source { get; }

    /// <summary>Referenced variable names (excluding t).</summary>
    public IReadOnlyList<string> Variables { get; }

    /// <summary>Whether the time variable t is used.</summary>
    public bool UsesTime { get; }

    /// <summary>Evaluates the expression; returns 0 when the result is not finite.</summary>
    public double Evaluate(IExpressionContext context)
    {
        var value = _evaluator(context);
        return double.IsNaN(value) || double.IsInfinity(value) ? 0 : value;
    }
}

/// <summary>
/// Expression compiler: turns expression text into a <see cref="CompiledExpression"/>.
/// Results are cached by source text to avoid re-parsing (the runtime only compiles once, while loading).
/// </summary>
public static class ExpressionCompiler
{
    private static readonly ConcurrentDictionary<string, CompiledExpression> Cache = new(StringComparer.Ordinal);

    /// <summary>Compiles an expression; throws <see cref="ExpressionException"/> on syntax errors.</summary>
    public static CompiledExpression Compile(string source)
    {
        if (source is null)
        {
            throw new ArgumentNullException(nameof(source));
        }

        if (Cache.TryGetValue(source, out var cached))
        {
            return cached;
        }

        var ast = ExpressionParser.Parse(source);
        var variables = new HashSet<string>(StringComparer.Ordinal);
        var flags = new CompilationFlags();
        var evaluator = Compile(ast, variables, flags);

        var compiled = new CompiledExpression(source, evaluator, variables.ToList(), flags.UsesTime);
        if (Cache.Count > 512)
        {
            Cache.Clear();
        }

        Cache[source] = compiled;
        return compiled;
    }

    /// <summary>Tries to compile; returns false and reports the error message on failure.</summary>
    public static bool TryCompile(string source, out CompiledExpression? compiled, out string? error)
    {
        try
        {
            compiled = Compile(source);
            error = null;
            return true;
        }
        catch (ExpressionException exception)
        {
            compiled = null;
            error = Strings.T("Expression.WithPosition", exception.Message, exception.Position);
            return false;
        }
        catch (Exception exception)
        {
            compiled = null;
            error = exception.Message;
            return false;
        }
    }

    private sealed class CompilationFlags
    {
        public bool UsesTime { get; set; }
    }

    private static Func<IExpressionContext, double> Compile(
        ExpressionNode node,
        HashSet<string> variables,
        CompilationFlags flags)
    {
        switch (node)
        {
            case NumberNode number:
            {
                var value = number.Value;
                return _ => value;
            }

            case VariableNode variable:
            {
                if (string.Equals(variable.Name, "t", StringComparison.OrdinalIgnoreCase))
                {
                    flags.UsesTime = true;
                    return context => context.Time;
                }

                variables.Add(variable.Name);
                var name = variable.Name;
                return context => context.TryGetVariable(name, out var value) ? value : 0;
            }

            case UnaryNode unary:
            {
                var operand = Compile(unary.Operand, variables, flags);
                return unary.Operator switch
                {
                    "-" => context => -operand(context),
                    "!" => context => operand(context) == 0 ? 1 : 0,
                    _ => operand,
                };
            }

            case BinaryNode binary:
            {
                var left = Compile(binary.Left, variables, flags);
                var right = Compile(binary.Right, variables, flags);
                return binary.Operator switch
                {
                    "+" => context => left(context) + right(context),
                    "-" => context => left(context) - right(context),
                    "*" => context => left(context) * right(context),
                    "/" => context =>
                    {
                        var divisor = right(context);
                        return divisor == 0 ? 0 : left(context) / divisor;
                    },
                    "%" => context =>
                    {
                        var divisor = right(context);
                        return divisor == 0 ? 0 : left(context) % divisor;
                    },
                    "^" => context => Math.Pow(left(context), right(context)),
                    "<" => context => left(context) < right(context) ? 1 : 0,
                    "<=" => context => left(context) <= right(context) ? 1 : 0,
                    ">" => context => left(context) > right(context) ? 1 : 0,
                    ">=" => context => left(context) >= right(context) ? 1 : 0,
                    "==" => context => Math.Abs(left(context) - right(context)) < 1e-12 ? 1 : 0,
                    "!=" => context => Math.Abs(left(context) - right(context)) < 1e-12 ? 0 : 1,
                    "&&" => context => left(context) != 0 && right(context) != 0 ? 1 : 0,
                    "||" => context => left(context) != 0 || right(context) != 0 ? 1 : 0,
                    _ => throw new ExpressionException(Strings.T("Expression.UnsupportedOperator", binary.Operator)),
                };
            }

            case ConditionalNode conditional:
            {
                var condition = Compile(conditional.Condition, variables, flags);
                var whenTrue = Compile(conditional.WhenTrue, variables, flags);
                var whenFalse = Compile(conditional.WhenFalse, variables, flags);
                return context => condition(context) != 0 ? whenTrue(context) : whenFalse(context);
            }

            case CallNode call:
            {
                var spec = ExpressionFunctions.Find(call.Name)
                    ?? throw new ExpressionException(Strings.T("Expression.UnsupportedFunction", call.Name));
                var arguments = call.Arguments.Select(argument => Compile(argument, variables, flags)).ToArray();
                var invoke = spec.Invoke;
                var buffer = new double[arguments.Length];

                return context =>
                {
                    for (var index = 0; index < arguments.Length; index++)
                    {
                        buffer[index] = arguments[index](context);
                    }

                    return invoke(buffer);
                };
            }

            default:
                throw new ExpressionException(Strings.T("Expression.UnknownNode"));
        }
    }
}
