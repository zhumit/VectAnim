using System.IO;
using System.Windows;
using System.Windows.Media;
using VectAnim.Wpf.Model;
using VectAnim.Wpf.Rendering;
using VectAnim.Wpf.Runtime;
using VectAnim.Wpf.Serialization;

namespace VectAnim.Wpf.Tests
{
    internal static class DocumentTests
    {
        public static void Register(TestRunner runner)
        {
            RegisterJsonTests(runner);
            RegisterValidatorTests(runner);
            RegisterRuntimeTests(runner);
            RegisterSceneTests(runner);
        }

        private static string SamplesDirectory()
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory is not null)
            {
                var candidate = Path.Combine(directory.FullName, "samples");
                if (Directory.Exists(candidate))
                {
                    return candidate;
                }

                directory = directory.Parent;
            }

            throw new DirectoryNotFoundException("The samples directory could not be found");
        }

        private static string GearSample => Path.Combine(SamplesDirectory(), "gear-demo.vectanim.json");

        private static string IndustrialSample => Path.Combine(SamplesDirectory(), "industrial-panel.vectanim.json");

        private static VectAnimDocument MinimalDocument()
        {
            return new VectAnimDocument
            {
                Canvas = new CanvasDefinition { Width = 400, Height = 300, Background = "#FFFFFFFF" },
                Variables = new List<VariableDefinition>
                {
                    new() { Name = "A", DefaultValue = 0 },
                    new() { Name = "B", DefaultValue = 0 },
                },
                Shapes = new List<ShapeDefinition>
                {
                    new()
                    {
                        Id = "rect1",
                        Name = "Rectangle",
                        Type = ShapeKind.Rectangle,
                        ZIndex = 10,
                        Fill = ValueRef.FromText("#FF0000"),
                        Stroke = ValueRef.FromText("#000000"),
                        StrokeThickness = ValueRef.FromNumber(2),
                        X = ValueRef.FromNumber(10),
                        Y = ValueRef.FromNumber(10),
                        Width = ValueRef.FromNumber(100),
                        Height = ValueRef.FromNumber(50),
                    },
                },
            };
        }

        private static void RegisterJsonTests(TestRunner runner)
        {
            const string suite = "JSON round-trip";

            runner.Add(suite, "Loads the sample document", () =>
            {
                var document = VectAnimJson.LoadFromFile(GearSample);
                Check.Equal(10, document.Shapes.Count);
                Check.Equal(9, document.Variables.Count);
                Check.Equal(4, document.ExpressionAnimations.Count);
                Check.Equal(1, document.KeyframeAnimations.Count);
                Check.Equal(2, document.Groups.Count);
                Check.Equal(800d, document.Canvas.Width);
            });

            runner.Add(suite, "Loads the industrial panel sample", () =>
            {
                var document = VectAnimJson.LoadFromFile(IndustrialSample);
                Check.Equal(18, document.Shapes.Count);
                Check.True(document.Shapes.Any(shape => shape.Type == ShapeKind.Path));
                Check.True(document.Shapes.Any(shape => shape.Type == ShapeKind.Polygon));
            });

            runner.Add(suite, "Save then reload preserves the document", () =>
            {
                var original = VectAnimJson.LoadFromFile(GearSample);
                var text = VectAnimJson.Save(original);
                var reloaded = VectAnimJson.LoadFromString(text);
                Check.Equal(original.Shapes.Count, reloaded.Shapes.Count);
                Check.Equal(original.Variables.Count, reloaded.Variables.Count);
                Check.Equal(original.Groups.Count, reloaded.Groups.Count);
                Check.Equal(original.ExpressionAnimations.Count, reloaded.ExpressionAnimations.Count);

                var gear = reloaded.Shapes.First(shape => shape.Id == "gear_01");
                Check.NotNull(gear.RenderTransform?.Rotate?.Value);
                Check.True(gear.RenderTransform!.Rotate!.Value!.IsBound);
                Check.Equal("GearAngle", gear.RenderTransform.Rotate.Value.Variable);
            });

            runner.Add(suite, "ValueRef in its three forms", () =>
            {
                var document = VectAnimJson.LoadFromString("""
                {
                  "Canvas": { "Width": 100, "Height": 100 },
                  "Shapes": [
                    { "Id": "a", "Type": "Rectangle",
                      "Fill": { "Const": "#FF0000" },
                      "Stroke": { "Const": null },
                      "Width": { "Bind": "W" },
                      "X": { "Const": 5 }, "Y": { "Const": 5 }, "Height": { "Const": 5 } }
                  ]
                }
                """);

                var shape = document.Shapes[0];
                Check.True(shape.Fill!.IsText);
                Check.Null(shape.Stroke);
                Check.True(shape.Width!.IsBound);
                Check.Equal("W", shape.Width.Variable);
                Check.Close(5, shape.X!.Number);
            });

            runner.Add(suite, "Tolerant parsing: comments, trailing commas, unknown enums", () =>
            {
                var document = VectAnimJson.LoadFromString("""
                {
                  // a hand-edited file
                  "Canvas": { "Width": 100, "Height": 100 },
                  "Shapes": [
                    { "Id": "a", "Type": "Rectangle", "LineCap": "Round", "X": {"Const":0}, "Y": {"Const":0}, "Width": {"Const":1}, "Height": {"Const":1} },
                  ],
                }
                """);

                Check.Equal(1, document.Shapes.Count);
                Check.Equal(LineCapStyle.Round, document.Shapes[0].LineCap);
            });

            runner.Add(suite, "Invalid JSON reports an error instead of crashing", () =>
            {
                Check.False(VectAnimJson.TryLoadFromString("{ not json", out var document, out var error));
                Check.Null(document);
                Check.NotNull(error);
            });
        }

        private static void RegisterValidatorTests(TestRunner runner)
        {
            const string suite = "Document validation";

            runner.Add(suite, "The sample document has no errors", () =>
            {
                var document = VectAnimJson.LoadFromFile(GearSample);
                var issues = DocumentValidator.Normalize(document);
                Check.False(issues.Any(issue => issue.Severity == ValidationSeverity.Error));
            });

            runner.Add(suite, "Unknown shape types are dropped", () =>
            {
                var document = VectAnimJson.LoadFromString("""
                {
                  "Canvas": { "Width": 100, "Height": 100 },
                  "Shapes": [ { "Id": "t1", "Type": "Text", "Data": "hello" } ]
                }
                """);
                Check.Equal(0, document.Shapes.Count);
            });

            runner.Add(suite, "Duplicate Ids are renamed automatically", () =>
            {
                var document = VectAnimJson.LoadFromString("""
                {
                  "Canvas": { "Width": 100, "Height": 100 },
                  "Shapes": [
                    { "Id": "dup", "Type": "Ellipse", "CenterX": {"Const":0}, "CenterY": {"Const":0}, "RadiusX": {"Const":1}, "RadiusY": {"Const":1} },
                    { "Id": "dup", "Type": "Ellipse", "CenterX": {"Const":0}, "CenterY": {"Const":0}, "RadiusX": {"Const":1}, "RadiusY": {"Const":1} }
                  ]
                }
                """);
                Check.Equal(2, document.Shapes.Select(shape => shape.Id).Distinct().Count());
            });

            runner.Add(suite, "Invalid path data is rejected", () =>
            {
                var document = VectAnimJson.LoadFromString("""
                {
                  "Canvas": { "Width": 100, "Height": 100 },
                  "Shapes": [ { "Id": "p", "Type": "Path", "Data": "M 0,0 X 1,1" } ]
                }
                """);
                Check.Equal(0, document.Shapes.Count);
            });

            runner.Add(suite, "Expression syntax errors are rejected", () =>
            {
                var document = VectAnimJson.LoadFromString("""
                {
                  "Canvas": { "Width": 100, "Height": 100 },
                  "Variables": [ { "Name": "A", "DefaultValue": 0 } ],
                  "ExpressionAnimations": [ { "Id": "e", "TargetVariable": "A", "Expression": "1 +", "Enabled": true } ]
                }
                """);
                Check.Equal(0, document.ExpressionAnimations.Count);
            });

            runner.Add(suite, "Group references to missing shapes are dropped", () =>
            {
                var document = VectAnimJson.LoadFromString("""
                {
                  "Canvas": { "Width": 100, "Height": 100 },
                  "Shapes": [ { "Id": "a", "Type": "Ellipse", "CenterX": {"Const":0}, "CenterY": {"Const":0}, "RadiusX": {"Const":1}, "RadiusY": {"Const":1} } ],
                  "Groups": [ { "GroupId": "g", "Name": "Group", "ShapeIds": ["a", "ghost"], "Visible": true } ]
                }
                """);
                Check.Equal(1, document.Groups[0].ShapeIds.Count);
            });

            runner.Add(suite, "Invalid canvas size falls back to the defaults", () =>
            {
                var document = VectAnimJson.LoadFromString("""
                { "Canvas": { "Width": 0, "Height": -5 } }
                """);
                Check.Close(800, document.Canvas.Width);
                Check.Close(600, document.Canvas.Height);
            });
        }

        private static void RegisterRuntimeTests(TestRunner runner)
        {
            const string suite = "Runtime";

            runner.Add(suite, "Expressions advance with t; external writes win", () =>
            {
                var document = MinimalDocument();
                document.ExpressionAnimations.Add(new ExpressionAnimationDefinition
                {
                    Id = "e1",
                    TargetVariable = "A",
                    Expression = "10 * t",
                    Enabled = true,
                });

                var runtime = new VectAnimRuntime(document);
                runtime.Play();
                runtime.Advance(0.5);
                Check.Close(5, runtime.GetVariable("A"));

                runtime.SetVariable("A", 99);
                runtime.Advance(0.5);
                Check.Close(99, runtime.GetVariable("A"));

                runtime.Variables.ClearExternal("A");
                runtime.Advance(0.5);
                Check.Close(15, runtime.GetVariable("A"));
            });

            runner.Add(suite, "Time does not accumulate while paused", () =>
            {
                var document = MinimalDocument();
                document.ExpressionAnimations.Add(new ExpressionAnimationDefinition
                {
                    Id = "e1",
                    TargetVariable = "A",
                    Expression = "t",
                    Enabled = true,
                });

                var runtime = new VectAnimRuntime(document);
                runtime.Play();
                runtime.Advance(0.4);
                runtime.Pause();
                runtime.Advance(1.0);
                Check.Close(0.4, runtime.GetVariable("A"));
                Check.Close(0.4, runtime.Time);
            });

            runner.Add(suite, "Dependencies are evaluated in topological order", () =>
            {
                var document = MinimalDocument();
                document.Variables.Add(new VariableDefinition { Name = "C", DefaultValue = 0 });
                document.ExpressionAnimations.Add(new ExpressionAnimationDefinition
                {
                    Id = "e2", TargetVariable = "C", Expression = "B * 10", Enabled = true,
                });
                document.ExpressionAnimations.Add(new ExpressionAnimationDefinition
                {
                    Id = "e1", TargetVariable = "B", Expression = "A + 1", Enabled = true,
                });

                var runtime = new VectAnimRuntime(document);
                runtime.SetVariable("A", 1);
                runtime.Recompute();
                Check.Close(2, runtime.GetVariable("B"));
                Check.Close(20, runtime.GetVariable("C"));
            });

            runner.Add(suite, "Wrap (modulo)", () =>
            {
                var document = MinimalDocument();
                document.ExpressionAnimations.Add(new ExpressionAnimationDefinition
                {
                    Id = "e1", TargetVariable = "A", Expression = "t * 100", Enabled = true, Wrap = 360,
                });

                var runtime = new VectAnimRuntime(document);
                runtime.Play();
                // A single step is capped at 1 second (to avoid frame jumps after a UI stall), so step 5 times
                for (var index = 0; index < 5; index++)
                {
                    runtime.Advance(1);
                }

                Check.Close(140, runtime.GetVariable("A"), 1e-6);
            });

            runner.Add(suite, "Keyframes drive variables", () =>
            {
                var document = MinimalDocument();
                document.KeyframeAnimations.Add(new KeyframeAnimationDefinition
                {
                    Id = "k1",
                    Name = "k",
                    TargetVariable = "B",
                    Loop = true,
                    Keyframes = new List<Keyframe>
                    {
                        new() { Time = 0, Value = 0 },
                        new() { Time = 1, Value = 100 },
                    },
                });

                var runtime = new VectAnimRuntime(document);
                runtime.Play();
                runtime.Advance(0.5);
                Check.Close(50, runtime.GetVariable("B"));
            });

            runner.Add(suite, "Missing variables are created automatically and reported", () =>
            {
                var document = MinimalDocument();
                document.ExpressionAnimations.Add(new ExpressionAnimationDefinition
                {
                    Id = "e1", TargetVariable = "Ghost", Expression = "1", Enabled = true,
                });

                var runtime = new VectAnimRuntime(document);
                Check.True(runtime.HasVariable("Ghost"));
                Check.True(runtime.Warnings.Any(warning => warning.Kind == RuntimeWarningKind.MissingVariable));
            });

            runner.Add(suite, "Circular dependencies are detected", () =>
            {
                var document = MinimalDocument();
                document.ExpressionAnimations.Add(new ExpressionAnimationDefinition
                {
                    Id = "e1", TargetVariable = "A", Expression = "B + 1", Enabled = true,
                });
                document.ExpressionAnimations.Add(new ExpressionAnimationDefinition
                {
                    Id = "e2", TargetVariable = "B", Expression = "A + 1", Enabled = true,
                });

                var runtime = new VectAnimRuntime(document);
                Check.True(runtime.Warnings.Any(warning => warning.Kind == RuntimeWarningKind.Cycle));
            });
        }

        private static void RegisterSceneTests(TestRunner runner)
        {
            const string suite = "Scene rendering";

            runner.Add(suite, "Loads the sample and builds render states", () =>
            {
                var document = VectAnimJson.LoadFromFile(GearSample);
                var runtime = new VectAnimRuntime(document);
                var scene = new SceneRenderer();
                scene.Load(document);
                scene.Update(runtime.Variables);
                Check.Equal(10, scene.ShapeCount);
                var gear = scene.GetState("gear_01");
                Check.NotNull(gear);
                Check.True(gear!.GeometryBounds.Width > 0);
            });

            runner.Add(suite, "Hit testing returns the topmost shape", () =>
            {
                var document = MinimalDocument();
                var runtime = new VectAnimRuntime(document);
                var scene = new SceneRenderer();
                scene.Load(document);
                scene.Update(runtime.Variables);

                Check.Equal("rect1", scene.HitTest(new Point(50, 30))?.Source.Id);
                Check.Null(scene.HitTest(new Point(300, 250)));
            });

            runner.Add(suite, "Hit testing still works after rotation", () =>
            {
                var document = MinimalDocument();
                document.Shapes[0].RenderTransform = new RenderTransformDefinition
                {
                    Rotate = new RotateDefinition
                    {
                        CenterX = ValueRef.FromNumber(60),
                        CenterY = ValueRef.FromNumber(35),
                        Value = ValueRef.FromNumber(90),
                    },
                };

                var runtime = new VectAnimRuntime(document);
                var scene = new SceneRenderer();
                scene.Load(document);
                scene.Update(runtime.Variables);

                // After a 90-degree rotation the rectangle becomes vertical: x in 35..85, y in -25..75
                Check.Equal("rect1", scene.HitTest(new Point(60, 70))?.Source.Id);
                Check.Null(scene.HitTest(new Point(100, 20)));
            });

            runner.Add(suite, "Bound variable changes trigger an update", () =>
            {
                var document = MinimalDocument();
                document.Shapes[0].Width = ValueRef.Bind("A");

                var runtime = new VectAnimRuntime(document);
                var scene = new SceneRenderer();
                scene.Load(document);
                Check.True(scene.Update(runtime.Variables));
                Check.False(scene.Update(runtime.Variables));

                runtime.SetVariable("A", 200);
                Check.True(scene.Update(runtime.Variables));
                Check.Close(200, scene.GetState("rect1")!.GeometryBounds.Width);
            });

            runner.Add(suite, "Groups hide their members", () =>
            {
                var document = MinimalDocument();
                document.Groups.Add(new ShapeGroup
                {
                    GroupId = "g1",
                    Name = "Group",
                    ShapeIds = new List<string> { "rect1" },
                    Visible = false,
                });

                var runtime = new VectAnimRuntime(document);
                var scene = new SceneRenderer();
                scene.Load(document);
                scene.Update(runtime.Variables);

                Check.False(scene.GetState("rect1")!.IsVisible);
                Check.Null(scene.HitTest(new Point(50, 30)));
            });

            runner.Add(suite, "Group transform moves its members", () =>
            {
                var document = MinimalDocument();
                document.Groups.Add(new ShapeGroup
                {
                    GroupId = "g1",
                    Name = "Group",
                    ShapeIds = new List<string> { "rect1" },
                    Visible = true,
                    RenderTransform = new RenderTransformDefinition
                    {
                        Translate = new TranslateDefinition { X = ValueRef.FromNumber(100), Y = ValueRef.FromNumber(0) },
                    },
                });

                var runtime = new VectAnimRuntime(document);
                var scene = new SceneRenderer();
                scene.Load(document);
                scene.Update(runtime.Variables);

                Check.NotNull(scene.HitTest(new Point(150, 30)), "the shape should have moved 100px to the right");
                Check.Null(scene.HitTest(new Point(50, 30)), "the original position should be empty now");
            });

            runner.Add(suite, "Group rotation turns its members around the group center", () =>
            {
                var document = MinimalDocument();
                document.Groups.Add(new ShapeGroup
                {
                    GroupId = "g1",
                    Name = "Group",
                    ShapeIds = new List<string> { "rect1" },
                    Visible = true,
                    RenderTransform = new RenderTransformDefinition
                    {
                        Rotate = new RotateDefinition
                        {
                            CenterX = ValueRef.FromNumber(60),
                            CenterY = ValueRef.FromNumber(35),
                            Value = ValueRef.Bind("Angle"),
                        },
                    },
                });

                var runtime = new VectAnimRuntime(document);
                var scene = new SceneRenderer();
                scene.Load(document);
                runtime.SetVariable("Angle", 90);
                scene.Update(runtime.Variables);

                // A 90° turn about the center makes the 100x50 rectangle 50x100 tall
                Check.NotNull(scene.HitTest(new Point(60, 80)), "the rotated rectangle should cover this point");
                Check.Null(scene.HitTest(new Point(105, 35)), "the unrotated right edge should be empty now");
            });

            runner.Add(suite, "Group opacity accepts a bare number and multiplies with the member", () =>
            {
                const string json = """
                {
                  "SchemaVersion": "1.0",
                  "Canvas": { "Width": 400, "Height": 300, "Background": "#FFFFFFFF" },
                  "Shapes": [
                    { "Id": "rect1", "Name": "R", "Type": "Rectangle", "ZIndex": 1,
                      "X": { "Const": 10 }, "Y": { "Const": 10 },
                      "Width": { "Const": 100 }, "Height": { "Const": 50 },
                      "Opacity": { "Const": 0.5 } }
                  ],
                  "Groups": [
                    { "GroupId": "g1", "Name": "G", "ShapeIds": ["rect1"], "Visible": true, "Opacity": 0.4 }
                  ]
                }
                """;

                var result = VectAnimJson.TryLoadFromString(json, out var document, out var error);
                Check.True(result, $"the document should load: {error}");
                Check.NotNull(document!.Groups[0].Opacity, "the bare number should become a constant reference");
                Check.Close(0.4, document.Groups[0].Opacity!.Number);
            });

            runner.Add(suite, "Numeric color bindings take effect", () =>
            {
                var document = MinimalDocument();
                document.Shapes[0].Fill = ValueRef.Bind("A");

                var runtime = new VectAnimRuntime(document);
                var scene = new SceneRenderer();
                scene.Load(document);
                runtime.SetVariable("A", 0x00FF00);
                scene.Update(runtime.Variables);

                var brush = scene.GetState("rect1")!.FillBrush as SolidColorBrush;
                Check.NotNull(brush);
                Check.Equal((byte)0x00, brush!.Color.R);
                Check.Equal((byte)0xFF, brush.Color.G);
            });
        }
    }
}
