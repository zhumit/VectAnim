using System.Windows;
using System.Windows.Media;
using VectAnim.Wpf.Animation;
using VectAnim.Wpf.Expressions;
using VectAnim.Wpf.Model;
using VectAnim.Wpf.Rendering;

namespace VectAnim.Wpf.Tests
{
    /// <summary>Expression evaluation context (test helper).</summary>
    internal sealed class TestContext : IExpressionContext
    {
        public Dictionary<string, double> Values { get; } = new(StringComparer.Ordinal);

        public double Time { get; set; }

        public bool TryGetVariable(string name, out double value) => Values.TryGetValue(name, out value);

        public static TestContext With(params (string Name, double Value)[] variables)
        {
            var context = new TestContext();
            foreach (var (name, value) in variables)
            {
                context.Values[name] = value;
            }

            return context;
        }
    }

    internal static class CoreTests
    {
        public static void Register(TestRunner runner)
        {
            RegisterExpressionTests(runner);
            RegisterKeyframeTests(runner);
            RegisterColorTests(runner);
            RegisterMatrixTests(runner);
        }

        private static double Eval(string source, TestContext? context = null)
        {
            var compiled = ExpressionCompiler.Compile(source);
            return compiled.Evaluate(context ?? new TestContext());
        }

        private static void RegisterExpressionTests(TestRunner runner)
        {
            const string suite = "Expression engine";

            runner.Add(suite, "Arithmetic and operator precedence", () =>
            {
                Check.Close(7, Eval("1 + 2 * 3"));
                Check.Close(9, Eval("(1 + 2) * 3"));
                Check.Close(2.5, Eval("10 / 4"));
                Check.Close(1, Eval("10 % 3"));
                Check.Close(512, Eval("2 ^ 3 ^ 2"));
                Check.Close(-4, Eval("-2 ^ 2"));
                Check.Close(0.5, Eval("2 ^ -1"));
            });

            runner.Add(suite, "Division by zero returns 0", () =>
            {
                Check.Close(0, Eval("5 / 0"));
                Check.Close(0, Eval("5 % 0"));
            });

            runner.Add(suite, "Variables and time t", () =>
            {
                var context = TestContext.With(("RPM", 100));
                context.Time = 2;
                Check.Close(1200, Eval("RPM * 6 * t", context));
                context.Time = 3.5;
                Check.Close(3.5, Eval("t", context));
            });

            runner.Add(suite, "Undefined variables evaluate to 0", () =>
            {
                Check.Close(5, Eval("Missing + 5"));
            });

            runner.Add(suite, "Trigonometric functions use degrees", () =>
            {
                Check.Close(0.5, Eval("sin(30)"), 1e-10);
                Check.Close(0.5, Eval("cos(60)"), 1e-10);
                Check.Close(45, Eval("atan2(1, 1)"), 1e-10);
                Check.Close(30, Eval("asin(0.5)"), 1e-10);
            });

            runner.Add(suite, "Whitelisted functions", () =>
            {
                Check.Close(100, Eval("clamp(150, 0, 100)"));
                Check.Close(2.5, Eval("lerp(0, 10, 0.25)"));
                Check.Close(330, Eval("mod(-30, 360)"));
                Check.Close(3.14, Eval("round(3.14159, 2)"));
                Check.Close(1, Eval("min(3, 1, 2)"));
                Check.Close(3, Eval("max(3, 1, 2)"));
                Check.Close(10, Eval("if(2 > 1, 10, 20)"));
                Check.Close(Math.PI, Eval("pi"));
                Check.Close(Math.E, Eval("e"));
            });

            runner.Add(suite, "Comparison, logic and the ternary operator", () =>
            {
                Check.Close(1, Eval("1 < 2"));
                Check.Close(0, Eval("1 > 2"));
                Check.Close(1, Eval("1 == 1 && 2 > 1"));
                Check.Close(0, Eval("0 || 0"));
                Check.Close(1, Eval("!0"));
                Check.Close(5, Eval("1 ? 5 : 9"));
            });

            runner.Add(suite, "Rejects functions outside the whitelist and string literals", () =>
            {
                Check.Throws<ExpressionException>(() => ExpressionCompiler.Compile("eval(\"1\")"));
                Check.Throws<ExpressionException>(() => ExpressionCompiler.Compile("danger(1)"));
                Check.Throws<ExpressionException>(() => ExpressionCompiler.Compile("System.IO.File.Delete(1)"));
                Check.True(ExpressionCompiler.TryCompile("abs(-1)", out _, out _));
            });

            runner.Add(suite, "Syntax errors carry a position", () =>
            {
                try
                {
                    ExpressionCompiler.Compile("1 + ");
                    throw new AssertionException("A syntax error should have been thrown");
                }
                catch (ExpressionException exception)
                {
                    Check.True(exception.Position >= 0);
                    Check.True(exception.Message.Length > 0);
                }
            });

            runner.Add(suite, "Dependency collection and the t flag", () =>
            {
                var compiled = ExpressionCompiler.Compile("RPM * 6 * t + Offset");
                Check.True(compiled.Variables.Contains("RPM"));
                Check.True(compiled.Variables.Contains("Offset"));
                Check.True(compiled.UsesTime);
                Check.False(ExpressionCompiler.Compile("RPM * 2").UsesTime);
            });

            runner.Add(suite, "Compiled expressions are cached", () =>
            {
                Check.True(ReferenceEquals(ExpressionCompiler.Compile("RPM + 1"), ExpressionCompiler.Compile("RPM + 1")));
            });

            runner.Add(suite, "Nested calls and negative arguments", () =>
            {
                Check.Close(-5, Eval("clamp(sin(-90) * 10, -5, 5)"));
                Check.Close(8, Eval("sqrt(16) + abs(-4)"));
            });
        }

        private static void RegisterKeyframeTests(TestRunner runner)
        {
            const string suite = "Keyframe sampling";

            var linear = new List<Keyframe>
            {
                new() { Time = 0, Value = 0 },
                new() { Time = 2, Value = 100 },
                new() { Time = 4, Value = 0 },
            };

            runner.Add(suite, "Linear interpolation", () =>
            {
                Check.Close(0, KeyframeSampler.Sample(linear, 0, false, 0)!.Value);
                Check.Close(50, KeyframeSampler.Sample(linear, 1, false, 0)!.Value);
                Check.Close(100, KeyframeSampler.Sample(linear, 2, false, 0)!.Value);
                Check.Close(50, KeyframeSampler.Sample(linear, 3, false, 0)!.Value);
            });

            runner.Add(suite, "Out-of-range times clamp to the first/last value", () =>
            {
                Check.Close(0, KeyframeSampler.Sample(linear, -5, false, 0)!.Value);
                Check.Close(0, KeyframeSampler.Sample(linear, 99, false, 0)!.Value);
            });

            runner.Add(suite, "Loop wrap-around", () =>
            {
                Check.Close(50, KeyframeSampler.Sample(linear, 5, true, 0)!.Value);
                Check.Close(0, KeyframeSampler.Sample(linear, 4, true, 0)!.Value);
                Check.Close(50, KeyframeSampler.Sample(linear, 9, true, 0)!.Value);
            });

            runner.Add(suite, "Loop delay holds the last keyframe value", () =>
            {
                Check.Close(0, KeyframeSampler.Sample(linear, 4.5, true, 1)!.Value);
                Check.Close(25, KeyframeSampler.Sample(linear, 5.5, true, 1)!.Value);
                Check.Close(50, KeyframeSampler.Sample(linear, 6, true, 1)!.Value);
            });

            runner.Add(suite, "Single frame / empty set", () =>
            {
                var single = new List<Keyframe> { new() { Time = 1, Value = 42 } };
                Check.Close(42, KeyframeSampler.Sample(single, 0, false, 0)!.Value);
                Check.Close(42, KeyframeSampler.Sample(single, 10, true, 0)!.Value);
                Check.Null(KeyframeSampler.Sample(new List<Keyframe>(), 1, false, 0));
            });

            runner.Add(suite, "Unsorted keyframes are sorted; duplicates keep the later frame", () =>
            {
                var frames = new List<Keyframe>
                {
                    new() { Time = 2, Value = 100 },
                    new() { Time = 0, Value = 0 },
                    new() { Time = 2, Value = 200 },
                };
                var sorted = KeyframeSampler.Sort(frames);
                Check.Equal(2, sorted.Count);
                Check.Close(200, sorted[1].Value);
                Check.Close(100, KeyframeSampler.Sample(frames, 1, false, 0)!.Value);
            });

            runner.Add(suite, "Easing endpoints and monotonicity", () =>
            {
                Check.Close(0, KeyframeSampler.ApplyEasing(EasingKind.EaseInOut, 0));
                Check.Close(1, KeyframeSampler.ApplyEasing(EasingKind.EaseInOut, 1));
                Check.True(KeyframeSampler.ApplyEasing(EasingKind.EaseIn, 0.5) < 0.5);
                Check.True(KeyframeSampler.ApplyEasing(EasingKind.EaseOut, 0.5) > 0.5);
                Check.Close(0, KeyframeSampler.ApplyEasing(EasingKind.Step, 0.9));
            });

            runner.Add(suite, "Easing is taken from the starting keyframe", () =>
            {
                var frames = new List<Keyframe>
                {
                    new() { Time = 0, Value = 0, Easing = EasingKind.EaseIn },
                    new() { Time = 1, Value = 100 },
                };
                Check.Close(25, KeyframeSampler.Sample(frames, 0.5, false, 0)!.Value);
            });
        }

        private static void RegisterColorTests(TestRunner runner)
        {
            const string suite = "Color parsing";

            runner.Add(suite, "WPF 8-digit #AARRGGBB", () =>
            {
                Check.True(ColorParser.TryParse("#80FF0000", out var color));
                Check.Equal((byte)0x80, color.A);
                Check.Equal((byte)0xFF, color.R);
                Check.Equal((byte)0x00, color.G);
            });

            runner.Add(suite, "6-digit and 3-digit hex", () =>
            {
                Check.True(ColorParser.TryParse("#FF0000", out var red));
                Check.Equal((byte)0xFF, red.A);
                Check.Equal((byte)0xFF, red.R);
                Check.True(ColorParser.TryParse("#0F0", out var green));
                Check.Equal((byte)0xFF, green.G);
            });

            runner.Add(suite, "CSS rgba and named colors", () =>
            {
                Check.True(ColorParser.TryParse("rgba(255, 0, 0, 0.5)", out var rgba));
                Check.Equal((byte)128, rgba.A);
                Check.Equal((byte)255, rgba.R);
                Check.True(ColorParser.TryParse("SteelBlue", out var named));
                Check.Equal((byte)0x46, named.R);
                Check.False(ColorParser.TryParse("not-a-color", out _));
            });

            runner.Add(suite, "Numeric color 0xRRGGBB", () =>
            {
                Check.True(ColorParser.TryParseNumber(0x00FF00, out var green));
                Check.Equal((byte)0xFF, green.G);
                Check.Equal((byte)0xFF, green.A);
                Check.True(ColorParser.TryParseNumber(16711680, out var red));
                Check.Equal((byte)0xFF, red.R);
                Check.False(ColorParser.TryParseNumber(-1, out _));
            });
        }

        private static void RegisterMatrixTests(TestRunner runner)
        {
            const string suite = "Transform matrix";

            runner.Add(suite, "Rotation about the center keeps the center fixed", () =>
            {
                var transform = new ResolvedTransform { Angle = 90, CenterX = 50, CenterY = 50, ScaleX = 1, ScaleY = 1 };
                var matrix = transform.ToMatrix();
                var center = matrix.Transform(new Point(50, 50));
                Check.Close(50, center.X);
                Check.Close(50, center.Y);
            });

            runner.Add(suite, "90-degree rotation goes clockwise", () =>
            {
                var transform = new ResolvedTransform { Angle = 90, CenterX = 50, CenterY = 50, ScaleX = 1, ScaleY = 1 };
                var matrix = transform.ToMatrix();
                var point = matrix.Transform(new Point(60, 50));
                Check.Close(50, point.X);
                Check.Close(60, point.Y);
            });

            runner.Add(suite, "Scale, then rotate, then translate", () =>
            {
                var transform = new ResolvedTransform
                {
                    Angle = 90,
                    CenterX = 50,
                    CenterY = 50,
                    ScaleX = 2,
                    ScaleY = 2,
                    TranslateX = 10,
                    TranslateY = 0,
                };
                var matrix = transform.ToMatrix();
                var point = matrix.Transform(new Point(60, 50));
                Check.Close(60, point.X);
                Check.Close(70, point.Y);
            });

            runner.Add(suite, "Identity transform yields the identity matrix", () =>
            {
                var transform = new ResolvedTransform { Angle = 0, CenterX = 0, CenterY = 0, ScaleX = 1, ScaleY = 1 };
                Check.True(transform.IsIdentity);
                Check.True(transform.ToMatrix().IsIdentity);
            });
        }
    }
}
