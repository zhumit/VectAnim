using System.Diagnostics;
using VectAnim.Wpf.Tests;

var runner = new TestRunner();
CoreTests.Register(runner);
DocumentTests.Register(runner);
LocalizationTests.Register(runner);
return runner.Run();

namespace VectAnim.Wpf.Tests
{
    /// <summary>Assertion failure.</summary>
    internal sealed class AssertionException : Exception
    {
        public AssertionException(string message) : base(message)
        {
        }
    }

    /// <summary>Minimal assertion helpers (no third-party test framework, so the runner works offline).</summary>
    internal static class Check
    {
        public static void True(bool condition, string message = "Assertion failed: expected true")
        {
            if (!condition)
            {
                throw new AssertionException(message);
            }
        }

        public static void False(bool condition, string message = "Assertion failed: expected false")
        {
            if (condition)
            {
                throw new AssertionException(message);
            }
        }

        public static void Equal<T>(T expected, T actual, string? message = null)
        {
            if (!EqualityComparer<T>.Default.Equals(expected, actual))
            {
                throw new AssertionException($"{message ?? "Values are not equal"}: expected {expected}, actual {actual}");
            }
        }

        public static void Close(double expected, double actual, double tolerance = 1e-6, string? message = null)
        {
            if (double.IsNaN(actual) || Math.Abs(expected - actual) > tolerance)
            {
                throw new AssertionException($"{message ?? "Values differ"}: expected {expected}, actual {actual} (tolerance {tolerance})");
            }
        }

        public static void NotNull(object? value, string message = "Expected a non-null value")
        {
            if (value is null)
            {
                throw new AssertionException(message);
            }
        }

        public static void Null(object? value, string message = "Expected null")
        {
            if (value is not null)
            {
                throw new AssertionException($"{message}, actual {value}");
            }
        }

        public static void Throws<TException>(Action action, string? message = null)
            where TException : Exception
        {
            try
            {
                action();
            }
            catch (TException)
            {
                return;
            }
            catch (Exception exception)
            {
                throw new AssertionException($"{message ?? "Unexpected exception type"}: expected {typeof(TException).Name}, actual {exception.GetType().Name} ({exception.Message})");
            }

            throw new AssertionException($"{message ?? "No exception was thrown"}: expected {typeof(TException).Name}");
        }

        public static void Contains(string expected, string? actual, string? message = null)
        {
            if (actual is null || !actual.Contains(expected, StringComparison.Ordinal))
            {
                throw new AssertionException($"{message ?? "Substring not found"}: \"{expected}\" is not part of \"{actual}\"");
            }
        }
    }

    /// <summary>Test case runner.</summary>
    internal sealed class TestRunner
    {
        private readonly List<(string Suite, string Name, Action Body)> _tests = new();

        public void Add(string suite, string name, Action body) => _tests.Add((suite, name, body));

        public int Run()
        {
            var failures = new List<string>();
            var currentSuite = string.Empty;
            var stopwatch = Stopwatch.StartNew();

            foreach (var (suite, name, body) in _tests)
            {
                if (!string.Equals(currentSuite, suite, StringComparison.Ordinal))
                {
                    currentSuite = suite;
                    Console.WriteLine();
                    Console.WriteLine($"── {suite} ──");
                }

                try
                {
                    body();
                    Console.WriteLine($"  ✓ {name}");
                }
                catch (Exception exception)
                {
                    var message = exception is AssertionException ? exception.Message : $"{exception.GetType().Name}: {exception.Message}";
                    Console.WriteLine($"  ✗ {name}");
                    Console.WriteLine($"      {message}");
                    failures.Add($"{suite} / {name}: {message}");
                }
            }

            stopwatch.Stop();
            Console.WriteLine();
            Console.WriteLine($"{_tests.Count} test(s), {_tests.Count - failures.Count} passed, {failures.Count} failed, {stopwatch.ElapsedMilliseconds} ms");
            if (failures.Count > 0)
            {
                Console.WriteLine();
                Console.WriteLine("Failures:");
                foreach (var failure in failures)
                {
                    Console.WriteLine($"  - {failure}");
                }

                return 1;
            }

            Console.WriteLine("All tests passed.");
            return 0;
        }
    }
}
