using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using VectAnim.Wpf.Localization;

namespace VectAnim.Demo
{
    /// <summary>
    /// Application entry point.
    ///
    /// Supports a <c>--smoke &lt;output.png&gt;</c> argument: creates the main window offscreen, captures a screenshot, then exits.
    /// Used for the UI smoke test in CI (verifies the XAML, the control host and the variable panel wiring).
    /// </summary>
    public partial class App : Application
    {
        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);

            var smokeIndex = Array.IndexOf(e.Args, "--smoke");
            if (smokeIndex >= 0)
            {
                var output = smokeIndex + 1 < e.Args.Length
                    ? e.Args[smokeIndex + 1]
                    : Path.Combine(AppContext.BaseDirectory, "demo-smoke.png");
                RunSmokeTest(output);
                return;
            }

            new MainWindow().Show();
        }

        private void RunSmokeTest(string outputPath)
        {
            var window = new MainWindow
            {
                Width = 1440,
                Height = 900,
                WindowStartupLocation = WindowStartupLocation.Manual,
                Left = -4000,
                Top = -4000,
                ShowInTaskbar = false,
            };
            window.Show();

            var timer = new DispatcherTimer(
                TimeSpan.FromMilliseconds(1200),
                DispatcherPriority.ApplicationIdle,
                (_, _) =>
                {
                    var exitCode = 1;
                    try
                    {
                        var root = (FrameworkElement)window.Content;
                        var width = Math.Max(1, (int)Math.Ceiling(root.ActualWidth));
                        var height = Math.Max(1, (int)Math.Ceiling(root.ActualHeight));
                        var bitmap = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
                        bitmap.Render(root);

                        var encoder = new PngBitmapEncoder();
                        encoder.Frames.Add(BitmapFrame.Create(bitmap));
                        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath))!);
                        using (var stream = File.Create(outputPath))
                        {
                            encoder.Save(stream);
                        }

                        var viewer = window.FindName("Viewer") as Wpf.Controls.VectAnimViewer;
                        var variablePanel = window.FindName("VariablePanel") as System.Windows.Controls.Panel;
                        var diagnostics = window.FindName("DiagnosticsList") as System.Windows.Controls.ListBox;

                        Console.WriteLine(Strings.T("Demo.SmokeWindowSize", width, height));
                        Console.WriteLine(Strings.T("Demo.SmokeShapeCount", viewer?.ShapeCount ?? -1));
                        Console.WriteLine(Strings.T("Demo.SmokeSliders", variablePanel?.Children.Count ?? -1));
                        Console.WriteLine(Strings.T("Demo.SmokeDiagnostics", diagnostics?.Items.Count ?? -1));
                        Console.WriteLine(Strings.T("Demo.SmokeScreenshot", Path.GetFullPath(outputPath)));

                        exitCode = viewer is { ShapeCount: > 0 } ? 0 : 2;
                    }
                    catch (Exception exception)
                    {
                        Console.WriteLine(Strings.T("Demo.SmokeFailed", exception));
                    }

                    Shutdown(exitCode);
                },
                Dispatcher);
            timer.Start();
        }
    }
}
