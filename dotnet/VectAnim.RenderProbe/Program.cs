using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using VectAnim.Wpf.Controls;

namespace VectAnim.RenderProbe
{
    /// <summary>
    /// Off-screen render probe: renders the sample documents to PNG through the WPF renderer and asserts on individual pixels.
    ///
    /// Purpose:
    ///  - prove that the WPF render path (OnRender / DrawingContext) really produces pixels;
    ///  - cross-check colors and positions against the editor preview;
    ///  - produce screenshots for delivery documents;
    ///  - roughly measure the per-frame render cost.
    /// </summary>
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            var root = LocateRepositoryRoot();
            var outputDirectory = Path.Combine(root, "artifacts", "wpf");
            Directory.CreateDirectory(outputDirectory);

            Console.WriteLine($"Output directory: {outputDirectory}");

            var failures = 0;
            failures += ProbeGear(root, outputDirectory);
            failures += ProbeIndustrial(root, outputDirectory);
            failures += ProbePerformance(root);

            Console.WriteLine();
            Console.WriteLine(failures == 0 ? "All render probes passed." : $"{failures} render probe check(s) failed.");
            return failures == 0 ? 0 : 1;
        }

        private static string LocateRepositoryRoot()
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory is not null)
            {
                if (Directory.Exists(Path.Combine(directory.FullName, "samples")))
                {
                    return directory.FullName;
                }

                directory = directory.Parent;
            }

            throw new DirectoryNotFoundException("The samples directory could not be found");
        }

        private static int ProbeGear(string root, string outputDirectory)
        {
            Console.WriteLine();
            Console.WriteLine("── Gear sample ──");
            var failures = 0;

            using var viewer = CreateViewer(800, 600);
            viewer.LoadFromFile(Path.Combine(root, "samples", "gear-demo.vectanim.json"));
            Report(viewer);

            foreach (var time in new[] { 0.0, 1.0, 2.5 })
            {
                viewer.SeekAnimation(time);
                var file = Path.Combine(outputDirectory, $"gear-t{time:0.0}.png");
                Save(viewer.RenderToBitmap(1), file);
                Console.WriteLine($"  Rendered t={time:0.0}s → {Path.GetFileName(file)}");
            }

            // Pixel assertion: the status lamp center should be green (LampColor = 0x00FF00)
            viewer.SeekAnimation(0);
            var bitmap = viewer.RenderToBitmap(1);
            var lamp = ReadPixel(bitmap, 680, 110);
            if (lamp.G > 200 && lamp.R < 60 && lamp.B < 60)
            {
                Console.WriteLine($"  ✓ Status lamp color is correct RGB({lamp.R},{lamp.G},{lamp.B})");
            }
            else
            {
                Console.WriteLine($"  ✗ Status lamp color is wrong RGB({lamp.R},{lamp.G},{lamp.B})");
                failures++;
            }

            // Pixel assertion: the gear body should be light gray (#E2E8F0) around the center (300,300)
            var gearPixel = ReadPixel(bitmap, 270, 270);
            if (Math.Abs(gearPixel.R - 0xE2) < 12 && Math.Abs(gearPixel.G - 0xE8) < 12 && Math.Abs(gearPixel.B - 0xF0) < 12)
            {
                Console.WriteLine($"  ✓ Gear fill color is correct RGB({gearPixel.R},{gearPixel.G},{gearPixel.B})");
            }
            else
            {
                Console.WriteLine($"  ✗ Gear fill color is wrong RGB({gearPixel.R},{gearPixel.G},{gearPixel.B})");
                failures++;
            }

            // Pixel assertion: the canvas background is white
            var background = ReadPixel(bitmap, 780, 580);
            if (background.R > 240 && background.G > 240 && background.B > 240)
            {
                Console.WriteLine($"  ✓ Canvas background is correct RGB({background.R},{background.G},{background.B})");
            }
            else
            {
                Console.WriteLine($"  ✗ Canvas background is wrong RGB({background.R},{background.G},{background.B})");
                failures++;
            }

            // Rotation check: the frames at t=0 and t=1 must differ (the gear is turning)
            var first = CaptureHash(viewer, 0);
            var second = CaptureHash(viewer, 1);
            if (!string.Equals(first, second, StringComparison.Ordinal))
            {
                Console.WriteLine("  ✓ Frames change over time (the gear rotates)");
            }
            else
            {
                Console.WriteLine("  ✗ Frames did not change");
                failures++;
            }

            // Shapes render mode
            viewer.RenderMode = VectAnimRenderMode.Shapes;
            viewer.SeekAnimation(1.5);
            var shapesBitmap = RenderElement(viewer);
            Save(shapesBitmap, Path.Combine(outputDirectory, "gear-shapes-mode.png"));
            Console.WriteLine("  ✓ Shapes render mode produced gear-shapes-mode.png");

            return failures;
        }

        private static int ProbeIndustrial(string root, string outputDirectory)
        {
            Console.WriteLine();
            Console.WriteLine("── Industrial panel sample ──");
            var failures = 0;

            using var viewer = CreateViewer(960, 600);
            viewer.LoadFromFile(Path.Combine(root, "samples", "industrial-panel.vectanim.json"));
            Report(viewer);

            viewer.SeekAnimation(0);
            var file = Path.Combine(outputDirectory, "industrial-t0.0.png");
            Save(viewer.RenderToBitmap(1), file);
            Console.WriteLine($"  Rendered t=0s → {Path.GetFileName(file)}");

            // Level binding: TankLevel = 62 → liquid height 146.3, color #0EA5E9
            var liquid = ReadPixel(viewer.RenderToBitmap(1), 160, 450);
            if (liquid.B > 150 && liquid.G > 120 && liquid.R < 120)
            {
                Console.WriteLine($"  ✓ Liquid level color is correct RGB({liquid.R},{liquid.G},{liquid.B})");
            }
            else
            {
                Console.WriteLine($"  ✗ Liquid level color is wrong RGB({liquid.R},{liquid.G},{liquid.B})");
                failures++;
            }

            // External write TankLevel = 0 → the liquid should disappear (height 0)
            viewer.SetVariable("TankLevel", 0);
            viewer.SetVariable("Alarm", 1);
            var drained = viewer.RenderToBitmap(1);
            Save(drained, Path.Combine(outputDirectory, "industrial-drained-alarm.png"));
            var drainedPixel = ReadPixel(drained, 160, 500);
            var lampPixel = ReadPixel(drained, 860, 70);
            if (drainedPixel.B < 120 && lampPixel.R > 200)
            {
                Console.WriteLine($"  ✓ External write applied: liquid cleared RGB({drainedPixel.R},{drainedPixel.G},{drainedPixel.B}), alarm lamp turned red RGB({lampPixel.R},{lampPixel.G},{lampPixel.B})");
            }
            else
            {
                Console.WriteLine($"  ✗ External write not applied: liquid RGB({drainedPixel.R},{drainedPixel.G},{drainedPixel.B}), lamp RGB({lampPixel.R},{lampPixel.G},{lampPixel.B})");
                failures++;
            }

            // Clearing the external flag only hands control back; the value keeps the last written result
            viewer.ClearExternal();
            var afterRelease = ReadPixel(viewer.RenderToBitmap(1), 160, 500);
            if (afterRelease.B < 120)
            {
                Console.WriteLine("  ✓ Last written value preserved after clearing the external flag (control returned, value not reset)");
            }
            else
            {
                Console.WriteLine($"  ✗ Clearing the external flag behaves unexpectedly RGB({afterRelease.R},{afterRelease.G},{afterRelease.B})");
                failures++;
            }

            // Only ResetVariables restores the default values
            viewer.ResetVariables();
            var restored = viewer.RenderToBitmap(1);
            var restoredPixel = ReadPixel(restored, 160, 450);
            if (restoredPixel.B > 150)
            {
                Console.WriteLine("  ✓ Default liquid level restored after clearing external writes");
            }
            else
            {
                Console.WriteLine($"  ✗ Value not restored after clearing external writes RGB({restoredPixel.R},{restoredPixel.G},{restoredPixel.B})");
                failures++;
            }

            // Hit testing
            viewer.SeekAnimation(0);
            var hit = viewer.HitTestShape(new Point(160, 400));
            if (hit is "tank_body" or "tank_liquid")
            {
                Console.WriteLine($"  ✓ Hit test returned {hit}");
            }
            else
            {
                Console.WriteLine($"  ✗ Hit test failed: {hit ?? "null"}");
                failures++;
            }

            return failures;
        }

        private static int ProbePerformance(string root)
        {
            Console.WriteLine();
            Console.WriteLine("── Performance probe (200-shape scene) ──");

            using var viewer = CreateViewer(800, 600);
            viewer.LoadFromString(BuildStressDocument(200));
            viewer.SeekAnimation(0);

            // Warm-up
            for (var index = 0; index < 5; index++)
            {
                viewer.SetVariable("Spin", index);
                _ = viewer.RenderToBitmap(1);
            }

            const int frames = 120;
            var stopwatch = Stopwatch.StartNew();
            for (var index = 0; index < frames; index++)
            {
                viewer.SetVariable("Spin", index * 3.0);
                _ = viewer.RenderToBitmap(1);
            }

            stopwatch.Stop();
            var perFrame = stopwatch.Elapsed.TotalMilliseconds / frames;
            Console.WriteLine($"  {frames} frames rendered in {stopwatch.ElapsedMilliseconds} ms, {perFrame:0.00} ms/frame on average (including bitmap export overhead)");

            if (perFrame > 50)
            {
                Console.WriteLine("  ✗ A single frame took more than 50 ms");
                return 1;
            }

            Console.WriteLine("  ✓ Render performance meets the real-time requirement");
            return 0;
        }

        private static string BuildStressDocument(int shapeCount)
        {
            var shapes = new List<string>();
            for (var index = 0; index < shapeCount; index++)
            {
                var row = index / 20;
                var column = index % 20;
                var x = 20 + (column * 38);
                var y = 20 + (row * 58);
                shapes.Add($$"""
                    {
                      "Id": "s{{index}}",
                      "Name": "Shape{{index}}",
                      "Type": "Rectangle",
                      "ZIndex": {{index}},
                      "Fill": { "Const": "#FF2D6CDF" },
                      "Stroke": { "Const": "#FF0B1220" },
                      "StrokeThickness": { "Const": 1 },
                      "X": { "Const": {{x}} },
                      "Y": { "Const": {{y}} },
                      "Width": { "Const": 30 },
                      "Height": { "Const": 46 },
                      "RenderTransform": {
                        "Rotate": { "CenterX": { "Const": {{x + 15}} }, "CenterY": { "Const": {{y + 23}} }, "Value": { "Bind": "Spin" } }
                      }
                    }
                    """);
            }

            return $$"""
            {
              "SchemaVersion": "1.0",
              "Canvas": { "Width": 800, "Height": 600, "Background": "#FFFFFFFF" },
              "Variables": [ { "Name": "Spin", "DefaultValue": 0 } ],
              "Shapes": [ {{string.Join(",", shapes)}} ]
            }
            """;
        }

        private static VectAnimViewer CreateViewer(double width, double height)
        {
            var viewer = new VectAnimViewer
            {
                Width = width,
                Height = height,
                Stretch = VectAnimStretch.Fill,
            };
            viewer.Measure(new Size(width, height));
            viewer.Arrange(new Rect(0, 0, width, height));
            viewer.UpdateLayout();
            return viewer;
        }

        private static void Report(VectAnimViewer viewer)
        {
            Console.WriteLine($"  {viewer.ShapeCount} shape(s), {viewer.VariableNames.Count} variable(s), duration {viewer.AnimationDuration:0.0}s");
            foreach (var issue in viewer.ValidationIssues)
            {
                Console.WriteLine($"  validation: {issue}");
            }

            foreach (var warning in viewer.RuntimeWarnings)
            {
                Console.WriteLine($"  warning: {warning}");
            }
        }

        private static void Save(BitmapSource bitmap, string path)
        {
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(bitmap));
            using var stream = File.Create(path);
            encoder.Save(stream);
        }

        private static BitmapSource RenderElement(FrameworkElement element)
        {
            var width = Math.Max(1, (int)Math.Ceiling(element.ActualWidth));
            var height = Math.Max(1, (int)Math.Ceiling(element.ActualHeight));
            var bitmap = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
            bitmap.Render(element);
            bitmap.Freeze();
            return bitmap;
        }

        private static Color ReadPixel(BitmapSource bitmap, int x, int y)
        {
            var clampedX = Math.Clamp(x, 0, bitmap.PixelWidth - 1);
            var clampedY = Math.Clamp(y, 0, bitmap.PixelHeight - 1);
            var pixels = new byte[4];
            var converted = new FormatConvertedBitmap(bitmap, PixelFormats.Bgra32, null, 0);
            converted.CopyPixels(new Int32Rect(clampedX, clampedY, 1, 1), pixels, 4, 0);
            return Color.FromArgb(pixels[3], pixels[2], pixels[1], pixels[0]);
        }

        private static string CaptureHash(VectAnimViewer viewer, double time)
        {
            viewer.SeekAnimation(time);
            var bitmap = viewer.RenderToBitmap(1);
            var stride = bitmap.PixelWidth * 4;
            var buffer = new byte[stride * bitmap.PixelHeight];
            bitmap.CopyPixels(buffer, stride, 0);
            return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(buffer));
        }
    }
}
