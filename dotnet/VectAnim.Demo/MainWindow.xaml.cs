using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using VectAnim.Wpf.Controls;
using VectAnim.Wpf.Localization;
using VectAnim.Wpf.Model;
using VectAnim.Wpf.Serialization;

namespace VectAnim.Demo
{
    /// <summary>
    /// Demo window: shows how to embed VectAnimViewer into an existing WPF project,
    /// and how the business layer injects variables (including writes from a background thread).
    /// </summary>
    public partial class MainWindow : Window
    {
        private readonly Stopwatch _fpsClock = Stopwatch.StartNew();
        private readonly Dictionary<string, Slider> _sliders = new(StringComparer.Ordinal);
        private readonly Dictionary<string, TextBlock> _valueLabels = new(StringComparer.Ordinal);
        private CancellationTokenSource? _plcCancellation;
        private int _frameCounter;
        private bool _suppressTimeSlider;
        private bool _updatingSliders;

        public MainWindow()
        {
            InitializeComponent();

            Viewer.LoadCompleted += OnViewerLoadCompleted;
            Viewer.LoadFailed += OnViewerLoadFailed;
            Viewer.ShapeClick += OnShapeClick;
            Viewer.ShapeMouseEnter += OnShapeEnter;
            Viewer.ShapeMouseLeave += OnShapeLeave;
            Viewer.VariableChanged += OnVariableChanged;
            Viewer.FrameRendered += OnFrameRendered;
            Viewer.PlaybackStateChanged += (_, _) => UpdatePlayButton();

            Loaded += (_, _) =>
            {
                LoadSample("samples/gear-demo.vectanim.json");
                CompositionTarget.Rendering += OnUiTick;
            };

            Closed += (_, _) => StopPlcSimulation();
        }

        private void OnUiTick(object? sender, EventArgs e)
        {
            if (_fpsClock.ElapsedMilliseconds >= 500)
            {
                var fps = _frameCounter * 1000.0 / _fpsClock.ElapsedMilliseconds;
                FpsText.Text = _frameCounter == 0 ? "idle" : $"{fps:0} fps";
                _fpsClock.Restart();
                _frameCounter = 0;
            }

            if (!_suppressTimeSlider)
            {
                _suppressTimeSlider = true;
                TimeSlider.Maximum = Math.Max(0.1, Viewer.AnimationDuration);
                TimeSlider.Value = Math.Min(TimeSlider.Maximum, Viewer.AnimationTime);
                TimeText.Text = $"{Viewer.AnimationTime:0.00} s";
                _suppressTimeSlider = false;
            }
        }

        private void OnFrameRendered(object? sender, EventArgs e) => _frameCounter++;

        private void LoadSample(string relativePath)
        {
            var path = Path.IsPathRooted(relativePath)
                ? relativePath
                : Path.Combine(AppContext.BaseDirectory, relativePath);

            if (!File.Exists(path))
            {
                AppendEvent(Strings.T("Demo.SampleNotFound", path));
                return;
            }

            StopPlcSimulation();
            PlcSimulationBox.IsChecked = false;
            Viewer.Source = path;
        }

        private void OnViewerLoadCompleted(object? sender, VectAnimLoadEventArgs e)
        {
            EmptyHint.Visibility = Visibility.Collapsed;
            SourceText.Text = DescribeSource(e.Source);
            ShapeCountText.Text = Strings.T("Demo.ShapeCountFormat", Viewer.ShapeCount);
            BuildVariableControls();

            DiagnosticsList.Items.Clear();
            foreach (var issue in Viewer.ValidationIssues)
            {
                DiagnosticsList.Items.Add($"[{issue.Severity}] {issue.Path}: {issue.Message}");
            }

            foreach (var warning in Viewer.RuntimeWarnings)
            {
                DiagnosticsList.Items.Add(Strings.T("Demo.RuntimeWarningPrefix", warning.Message));
            }

            if (DiagnosticsList.Items.Count == 0)
            {
                DiagnosticsList.Items.Add(Strings.T("Demo.NoWarnings"));
            }

            StatusText.Text = Strings.T("Demo.LoadedStatus", Path.GetFileName(e.Source) ?? string.Empty);
            AppendEvent(Strings.T("Demo.LoadCompletedLog", Viewer.ShapeCount, Viewer.VariableNames.Count));
        }

        private void OnViewerLoadFailed(object? sender, VectAnimLoadFailedEventArgs e)
        {
            StatusText.Text = Strings.T("Demo.LoadFailedStatus", e.Message);
            AppendEvent(Strings.T("Demo.LoadFailedStatus", e.Message));
            MessageBox.Show(this, e.Message, Strings.T("Demo.LoadFailedTitle"), MessageBoxButton.OK, MessageBoxImage.Warning);
        }

        private void BuildVariableControls()
        {
            VariablePanel.Children.Clear();
            _sliders.Clear();
            _valueLabels.Clear();

            var document = Viewer.Document;
            if (document is null)
            {
                return;
            }

            foreach (var variable in document.Variables)
            {
                var minimum = variable.Min ?? 0;
                var maximum = variable.Max ?? Math.Max(1, variable.DefaultValue * 2);
                if (Math.Abs(maximum - minimum) < 1e-9)
                {
                    maximum = minimum + 1;
                }

                var header = new DockPanel { Margin = new Thickness(0, 4, 0, 0) };
                var name = new TextBlock
                {
                    Text = variable.Name,
                    FontFamily = new FontFamily("Consolas"),
                    Foreground = (Brush)FindResource("AccentBrush"),
                    FontSize = 11.5,
                    ToolTip = variable.Description,
                };
                var value = new TextBlock
                {
                    Text = Viewer.GetVariable(variable.Name).ToString("0.##"),
                    FontFamily = new FontFamily("Consolas"),
                    FontSize = 11.5,
                    HorizontalAlignment = HorizontalAlignment.Right,
                };
                DockPanel.SetDock(value, Dock.Right);
                header.Children.Add(value);
                header.Children.Add(name);

                var slider = new Slider
                {
                    Minimum = Math.Min(minimum, maximum),
                    Maximum = Math.Max(minimum, maximum),
                    Value = Math.Clamp(Viewer.GetVariable(variable.Name), Math.Min(minimum, maximum), Math.Max(minimum, maximum)),
                    Tag = variable.Name,
                    IsMoveToPointEnabled = true,
                };
                slider.ValueChanged += OnVariableSliderChanged;

                _sliders[variable.Name] = slider;
                _valueLabels[variable.Name] = value;

                VariablePanel.Children.Add(header);
                VariablePanel.Children.Add(slider);
            }
        }

        private void OnVariableSliderChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
        {
            if (_updatingSliders || sender is not Slider slider || slider.Tag is not string name)
            {
                return;
            }

            Viewer.SetVariable(name, e.NewValue);
            if (_valueLabels.TryGetValue(name, out var label))
            {
                label.Text = e.NewValue.ToString("0.##");
            }
        }

        private void OnVariableChanged(object? sender, VectAnimVariableChangedEventArgs e)
        {
            if (_updatingSliders)
            {
                return;
            }

            // Mirror animation-driven variables to the sliders so they are easy to observe
            if (_sliders.TryGetValue(e.Name, out var slider) && !Viewer.IsExternallyDriven(e.Name))
            {
                _updatingSliders = true;
                slider.Value = Math.Clamp(e.Value, slider.Minimum, slider.Maximum);
                _updatingSliders = false;
            }

            if (_valueLabels.TryGetValue(e.Name, out var label))
            {
                label.Text = e.Value.ToString("0.##");
            }
        }

        private void OnShapeClick(object? sender, VectAnimShapeEventArgs e)
        {
            AppendEvent(Strings.T("Demo.ShapeClickLog", e.ShapeName, e.ShapeId, e.CanvasPoint.X.ToString("0.#"), e.CanvasPoint.Y.ToString("0.#")));
            StatusText.Text = Strings.T("Demo.ShapeClickStatus", e.ShapeName);
        }

        private void OnShapeEnter(object? sender, VectAnimShapeEventArgs e)
        {
            HoverText.Text = Strings.T("Demo.HitShape", e.ShapeId);
        }

        private void OnShapeLeave(object? sender, VectAnimShapeEventArgs e)
        {
            HoverText.Text = Strings.T("Demo.HitNone");
        }

        private void AppendEvent(string message)
        {
            EventList.Items.Insert(0, $"{DateTime.Now:HH:mm:ss}  {message}");
            while (EventList.Items.Count > 60)
            {
                EventList.Items.RemoveAt(EventList.Items.Count - 1);
            }
        }

        /// <summary>
        /// Renders the loaded document path as "folder/file" so the panel stays readable and
        /// screenshots never leak absolute machine paths.
        /// </summary>
        private static string DescribeSource(string? source)
        {
            if (string.IsNullOrWhiteSpace(source))
            {
                return "—";
            }

            try
            {
                var file = Path.GetFileName(source);
                var folder = Path.GetFileName(Path.GetDirectoryName(source));
                return string.IsNullOrEmpty(folder) ? file : $"{folder}/{file}";
            }
            catch (ArgumentException)
            {
                // Fall back to the raw value below.
            }

            return source;
        }

        private void UpdatePlayButton()
        {
            PlayButton.Content = Viewer.IsAnimationPlaying ? Strings.T("Demo.Pause") : Strings.T("Demo.Play");
        }

        private void OnPlayPause(object sender, RoutedEventArgs e)
        {
            if (Viewer.IsAnimationPlaying)
            {
                Viewer.PauseAnimation();
            }
            else
            {
                Viewer.PlayAnimation();
            }

            UpdatePlayButton();
        }

        private void OnStop(object sender, RoutedEventArgs e)
        {
            Viewer.StopAnimation();
            UpdatePlayButton();
        }

        private void OnTimeSliderChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
        {
            if (_suppressTimeSlider)
            {
                return;
            }

            Viewer.SeekAnimation(e.NewValue);
        }

        private void OnAutoPlayChanged(object sender, RoutedEventArgs e)
        {
            Viewer.AutoPlay = AutoPlayBox.IsChecked == true;
        }

        private void OnClearExternal(object sender, RoutedEventArgs e)
        {
            Viewer.ClearExternal();
            AppendEvent(Strings.T("Demo.ExternalCleared"));
        }

        private void OnRenderModeChanged(object sender, SelectionChangedEventArgs e)
        {
            if (Viewer is null)
            {
                return;
            }

            Viewer.RenderMode = RenderModeBox.SelectedIndex == 1
                ? VectAnimRenderMode.Shapes
                : VectAnimRenderMode.Drawing;
            AppendEvent(Strings.T("Demo.RenderModeChanged", Viewer.RenderMode));
        }

        private void OnStretchChanged(object sender, SelectionChangedEventArgs e)
        {
            if (Viewer is null)
            {
                return;
            }

            Viewer.Stretch = StretchBox.SelectedIndex switch
            {
                1 => VectAnimStretch.UniformToFill,
                2 => VectAnimStretch.Fill,
                3 => VectAnimStretch.None,
                _ => VectAnimStretch.Uniform,
            };
        }

        private void OnLoadGearSample(object sender, RoutedEventArgs e) => LoadSample("samples/gear-demo.vectanim.json");

        private void OnLoadIndustrialSample(object sender, RoutedEventArgs e) => LoadSample("samples/industrial-panel.vectanim.json");

        private void OnOpenFile(object sender, RoutedEventArgs e)
        {
            var dialog = new Microsoft.Win32.OpenFileDialog
            {
                Filter = Strings.T("Demo.OpenFileFilter"),
                Title = Strings.T("Demo.OpenFileTitle"),
            };

            if (dialog.ShowDialog(this) == true)
            {
                Viewer.Source = dialog.FileName;
            }
        }

        /// <summary>
        /// Simulates a PLC: a background thread writes variables periodically to verify the cross-thread safety of the control.
        /// </summary>
        private void OnPlcSimulationChanged(object sender, RoutedEventArgs e)
        {
            if (PlcSimulationBox.IsChecked == true)
            {
                StartPlcSimulation();
            }
            else
            {
                StopPlcSimulation();
            }
        }

        private void StartPlcSimulation()
        {
            StopPlcSimulation();
            _plcCancellation = new CancellationTokenSource();
            var token = _plcCancellation.Token;
            AppendEvent(Strings.T("Demo.PlcStarted"));

            _ = Task.Run(async () =>
            {
                var clock = Stopwatch.StartNew();
                while (!token.IsCancellationRequested)
                {
                    var phase = clock.Elapsed.TotalSeconds;
                    // Write straight from the worker thread; the control marshals back to the UI thread internally
                    Viewer.SetVariable("RPM", 1200 + (Math.Sin(phase) * 900));
                    Viewer.SetVariable("MotorRPM", 900 + (Math.Sin(phase * 0.7) * 600));
                    Viewer.SetVariable("TankLevel", 50 + (Math.Sin(phase * 0.5) * 45));
                    Viewer.SetVariable("Pressure", 0.8 + (Math.Sin(phase * 0.9) * 0.7));
                    Viewer.SetVariable("Alarm", Math.Sin(phase * 0.4) > 0.6 ? 1 : 0);

                    try
                    {
                        await Task.Delay(60, token);
                    }
                    catch (TaskCanceledException)
                    {
                        break;
                    }
                }
            }, token);
        }

        private void StopPlcSimulation()
        {
            if (_plcCancellation is null)
            {
                return;
            }

            _plcCancellation.Cancel();
            _plcCancellation.Dispose();
            _plcCancellation = null;
        }
    }
}
