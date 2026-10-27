# VectAnim.Wpf 控件 API 手册

> [English](en/04-wpf-control-api.md) | 中文

`VectAnim.Wpf.dll` 提供自定义控件 `VectAnimViewer`，可直接放入任意 WPF 窗口 / UserControl / DataTemplate。

- 目标框架：`net8.0-windows`（同时可在 .NET 6/7 引用源码工程，见「部署与集成」）
- 依赖：**无第三方依赖**（JSON 用 `System.Text.Json`，表达式为内置编译器）
- 渲染：默认 `OnRender + DrawingContext`，不创建任何 `Shape` 对象

---

## 1. 最小用法

```xml
<Window xmlns:va="clr-namespace:VectAnim.Wpf.Controls;assembly=VectAnim.Wpf">
    <va:VectAnimViewer x:Name="Viewer"
                       Source="panels/gear-demo.vectanim.json"
                       AutoPlay="True" />
</Window>
```

```csharp
// 业务层注入数据（PLC / 串口 / ViewModel 均可）
Viewer.SetVariable("RPM", 1200);

// 读取动画计算出的变量
double angle = Viewer.GetVariable("GearAngle");
```

---

## 2. 依赖属性

| 属性 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `Source` | string | null | 文档路径；赋值后立即加载（失败触发 `LoadFailed`，保留旧画面） |
| `AutoPlay` | bool | false | 加载后自动播放内置动画 |
| `AnimationEnabled` | bool | true | 内置动画总开关；关闭后仍可响应外部变量 |
| `AnimationSpeed` | double | 1.0 | 动画速度倍率（0.5 = 半速） |
| `RenderMode` | enum | `Drawing` | `Drawing`（OnRender）/ `Shapes`（生成 Path 视觉对象） |
| `Stretch` | enum | `Uniform` | `None` / `Uniform` / `UniformToFill` / `Fill` |
| `Zoom` | double | 1.0 | 额外缩放（以控件中心为基准，0.01~100） |
| `OffsetX` / `OffsetY` | double | 0 | 额外平移（控件坐标） |
| `Interactive` | bool | true | 是否响应点击/悬停并改变光标 |
| `ExternalWriteTimeout` | double | 0 | 外部写入有效期（毫秒）；>0 时超时后自动交还动画驱动，0 = 永久 |

---

## 3. 方法

### 3.1 加载

| 方法 | 说明 |
| --- | --- |
| `LoadFromFile(string path)` | 从文件加载（同步，内部完成校验与规范化） |
| `LoadFromString(string json, string? sourceName = null)` | 从 JSON 文本加载（可来自数据库/网络） |
| `LoadFromDocument(VectAnimDocument doc, string? sourceName = null)` | 直接传入文档对象（会再规范化一次） |
| `Reload()` | 重新加载当前来源 |
| `Unload()` | 卸载文档并清空画面 |

> 加载失败不会抛异常到调用方，而是触发 `LoadFailed` 事件并保留原画面 —— 工业现场不允许因为一份坏文件把整条产线画面清空。

### 3.2 变量

| 方法 | 说明 |
| --- | --- |
| `SetVariable(string name, double value)` | 写入变量（**任意线程**可调用，内部自动切回 UI 线程） |
| `SetVariables(IEnumerable<KeyValuePair<string,double>>)` | 批量写入，只重绘一次 |
| `GetVariable(string name)` | 读取当前值（不存在返回 0） |
| `TryGetVariable(string name, out double value)` | 安全读取 |
| `HasVariable(string name)` | 是否已定义 |
| `ClearExternal(string? name = null)` | 清除外部写入标记（传 null 清除全部），把控制权交还动画；**不改变当前数值** |
| `ResetVariables()` | 恢复所有变量默认值并清除外部标记 |
| `IsExternallyDriven(string name)` | 该变量当前是否被外部驱动 |
| `BeginUpdate()` / `EndUpdate()` | 合并多次修改，只重绘一次 |

**外部写入优先级**（核心时序规则）：

```
外部业务写入 > 关键帧动画 > 表达式动画 > 变量默认值
```

一旦某变量被外部写入，表达式/关键帧不再覆盖它；`ClearExternal` 后动画重新接管。

### 3.3 播放

| 方法 | 说明 |
| --- | --- |
| `PlayAnimation()` | 开始/继续播放（`t` 从当前值继续累加） |
| `PauseAnimation()` | 暂停（`t` 停止累加，画面保持） |
| `StopAnimation()` | 停止并回到 `t = 0` |
| `SeekAnimation(double seconds)` | 跳到指定时间（可用于时间轴拖动） |

### 3.4 查询与工具

| 成员 | 说明 |
| --- | --- |
| `Document` | 当前文档（未加载为 null） |
| `ValidationIssues` | 加载期校验问题列表 |
| `RuntimeWarnings` | 运行时告警（缺变量、表达式错误、循环依赖…） |
| `ShapeCount` / `VariableNames` | 图形数量 / 变量名集合 |
| `IsAnimationPlaying` / `AnimationTime` / `AnimationDuration` | 播放状态与时间信息 |
| `HitTestShape(Point controlPoint)` | 命中测试，返回图形 Id |
| `ToCanvasPoint(Point controlPoint)` | 控件坐标 → 画布坐标 |
| `GetViewMatrix()` | 画布 → 控件的视图矩阵 |
| `RenderToBitmap(double scale = 1)` | 离屏渲染为 `BitmapSource`（打印/报表/缩略图） |
| `Dispose()` | 释放动画钩子（自定义宿主中建议在窗口关闭时调用） |

---

## 4. 事件

### 4.1 交互事件（冒泡路由事件）

| 事件 | 参数 | 说明 |
| --- | --- | --- |
| `ShapeClick` | `VectAnimShapeEventArgs` | 左键点击图形（最上层命中） |
| `ShapeRightClick` | 同上 | 右键点击图形 |
| `ShapeMouseDown` / `ShapeMouseUp` | 同上 | 图形上按下 / 释放 |
| `ShapeMouseEnter` / `ShapeMouseLeave` | 同上 | 悬停进入 / 离开 |

`VectAnimShapeEventArgs` 携带：

- `ShapeId` / `ShapeName`：命中的图形
- `CanvasPoint`：**画布坐标**（不受缩放影响，可直接与 JSON 里的坐标对比）
- `ControlPoint`：控件坐标
- `Button`：触发的鼠标键（悬停为 null）

```csharp
Viewer.ShapeClick += (_, e) =>
{
    if (e.ShapeId == "alarm_lamp")
    {
        MessageBox.Show($"报警灯被点击，画布坐标 ({e.CanvasPoint.X:0.#}, {e.CanvasPoint.Y:0.#})");
    }
};
```

命中测试基于**几何**（`FillContains` / `StrokeContains`，并考虑旋转变换），不是矩形包围盒 —— 因此齿轮齿间空隙点击不会被误判。

### 4.2 状态事件

| 事件 | 说明 |
| --- | --- |
| `LoadCompleted` | 加载成功，携带校验问题列表 |
| `LoadFailed` | 加载失败，携带异常 |
| `WarningRaised` | 运行时告警（每个告警一次） |
| `VariableChanged` | 变量值变化（动画驱动或外部写入） |
| `PlaybackStateChanged` | 播放/暂停状态变化 |
| `FrameRendered` | 每次渲染完成（可用于性能统计） |

---

## 5. 渲染模式

### Drawing（默认，推荐）

```
OnRender → DrawingContext.DrawGeometry(fill, pen, geometry)
```

- 不为每个图形创建 WPF 对象，图形数量多时性能显著优于 Canvas + Shape；
- 几何、画刷、画笔全部缓存并冻结，每帧只更新矩阵；
- 实测 200 个带旋转绑定的图形，约 **7.5 ms/帧**（含位图导出开销，见 `VectAnim.RenderProbe`）。

### Shapes

```
视觉树中维护 Path 对象，逐帧更新 Data / Fill / Stroke / RenderTransform
```

- 适合需要 WPF 原生命中测试、`Effect`、`BitmapCache` 的场景；
- 图形数量大时开销明显高于 Drawing 模式；
- 切换只需设置 `RenderMode`，画面内容完全一致。

---

## 6. 线程模型

| 操作 | 线程要求 |
| --- | --- |
| `SetVariable` / `SetVariables` | **任意线程**（内部 `Dispatcher.BeginInvoke` 切回 UI） |
| `ClearExternal` / `ResetVariables` / `SeekAnimation` | 任意线程（同上） |
| `LoadFromFile` / `LoadFromString` | 建议 UI 线程 |
| 读取 `GetVariable` | 任意线程（只读字典，无锁） |

典型 PLC 采集线程：

```csharp
_ = Task.Run(async () =>
{
    while (!token.IsCancellationRequested)
    {
        var snapshot = await _plc.ReadAsync();       // 你自己的采集逻辑
        Viewer.SetVariables(snapshot);               // 内部切回 UI 线程并重绘
        await Task.Delay(50, token);
    }
});
```

> 高频写入建议用 `SetVariables` 批量提交：一次重绘，避免每条变量都触发一次 `InvalidateVisual`。

---

## 7. 集成示例

### 7.1 与 MVVM 结合

```csharp
public sealed class PanelViewModel : INotifyPropertyChanged
{
    private double _rpm;
    public double Rpm
    {
        get => _rpm;
        set
        {
            _rpm = value;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Rpm)));
        }
    }

    public event PropertyChangedEventHandler? PropertyChanged;
}
```

```csharp
// 在 View 中订阅 ViewModel（也可以用绑定 + 附加属性封装）
viewModel.PropertyChanged += (_, e) =>
{
    if (e.PropertyName == nameof(PanelViewModel.Rpm))
    {
        Viewer.SetVariable("RPM", viewModel.Rpm);
    }
};
```

### 7.2 点击告警弹窗

```csharp
Viewer.ShapeClick += async (_, e) =>
{
    if (e.ShapeId.StartsWith("alarm"))
    {
        await DialogService.ShowAsync($"设备 {e.ShapeName} 报警，请检查");
    }
};
```

### 7.3 截图 / 打印

```csharp
var bitmap = Viewer.RenderToBitmap(2);   // 2 倍分辨率
var encoder = new PngBitmapEncoder();
encoder.Frames.Add(BitmapFrame.Create(bitmap));
using var stream = File.Create("snapshot.png");
encoder.Save(stream);
```

### 7.4 拖放加载

```csharp
private void OnDrop(object sender, DragEventArgs e)
{
    if (e.Data.GetData(DataFormats.FileDrop) is string[] { Length: > 0 } files)
    {
        Viewer.LoadFromFile(files[0]);
    }
}
```

---

## 8. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 画面空白 | 检查 `LoadFailed` 与 `ValidationIssues`；常见为路径非法、画布尺寸为 0 |
| 图形不跟随变量 | 该变量被外部写入后动画不再驱动；调用 `ClearExternal` 或检查表达式是否引用了它 |
| 动画不动 | `AnimationEnabled=false`、未调用 `PlayAnimation`、或所有目标变量都被外部接管 |
| 角度越转越慢/抖动 | 表达式未加 `Wrap: 360`，浮点累积误差；加上取模即可 |
| 颜色不对/透明 | 8 位十六进制被写成 CSS 顺序（`#RRGGBBAA`），应使用 `#AARRGGBB` |
| 中文乱码 | 文件须为 UTF-8（无 BOM 也可） |
| 高频写入卡顿 | 改用 `SetVariables` 批量写入，或调大采集周期 |

`RuntimeWarnings` 是排查的第一入口，它会在以下情况给出明确说明：

- 表达式目标变量不存在（自动创建为 0）
- 表达式引用了未定义变量（按 0 处理）
- 表达式无法编译（跳过该动画）
- 表达式之间存在循环依赖（降级处理）
- 关键帧动画没有关键帧

---

## 9. 性能建议

1. 优先使用 `RenderMode="Drawing"`。
2. 常量属性不要写 `{"Const": ...}` 之外的形式（绑定会带来每帧解析开销，虽小但可避免）。
3. 大量图形时避免给每个图形都加旋转绑定；只给真正需要动的加。
4. `Stretch="None"` 且尺寸固定时，WPF 不需要每帧重算视图矩阵。
5. 高频数据（> 30 Hz）建议在业务层做**变化检测**，只有值真的变化才 `SetVariable`。
6. 需要导出图片时用 `RenderToBitmap`，不要在 UI 线程上反复 `RenderTargetBitmap`。

---

## 10. 界面语言（本地化）

控件自身的提示文案（校验问题、运行时告警、Demo 界面）走内置字符串表 `VectAnim.Wpf.Localization.Strings`：

- **默认英文**；简体中文为第二语言，两套表都编译进程序集，不依赖 `.resx` 卫星程序集，单文件发布友好。
- 启动前设置环境变量 `VECTANIM_LANG=zh-CN`（或 `zh`）即可整体切换；也可在运行时改 `Strings.Culture`。
- `Strings.T("key")` 查表，缺键时回落英文、再回落 key 本身；`Strings.MissingKeys` 可列出缺失翻译（便于自检）。

```csharp
Strings.Culture = new CultureInfo("zh-CN");   // 运行时切换
string text = Strings.T("Demo.ShapeCountFormat", 10);
```

> 注意：`Strings` 只覆盖控件与 Demo 自身的文案，**不翻译** `.vectanim.json` 里的内容（图形名、变量名、备注属于文档数据）。
