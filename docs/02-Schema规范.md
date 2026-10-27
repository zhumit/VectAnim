# VectAnim Schema 规范（v1.0）

> [English](en/02-schema-specification.md) | 中文

`.vectanim.json` 是编辑器与 WPF 运行时之间**唯一的数据契约**。本文件是权威说明；任何字段变更都必须同步更新本文件、编辑器（TypeScript）与运行时（C#）两侧。

- 文件后缀：`.vectanim.json`（本质是 UTF-8 JSON，允许注释与尾逗号）
- 顶层版本字段：`"SchemaVersion": "1.0"`
- 坐标系：**左上角为原点 (0,0)，X 向右，Y 向下**，单位为 WPF 设备无关像素（DIP）
- 角度单位：**度（°）**，顺时针为正（与 `Fabric.angle`、`RotateTransform.Angle` 一致）
- 命名：所有 JSON 字段为 PascalCase，C# 反序列化零映射

---

## 1. 顶层结构

```jsonc
{
  "SchemaVersion": "1.0",
  "Canvas": { ... },                 // 必填
  "Variables": [ ... ],              // 变量表
  "Shapes": [ ... ],                 // 图形集合（扁平结构）
  "ExpressionAnimations": [ ... ],   // 表达式动画
  "KeyframeAnimations": [ ... ],     // 关键帧动画
  "Groups": [ ... ],                 // 分组（扁平，一个图形最多属于一个分组）
  "Meta": { ... }                    // 可选：标题/作者等元信息
}
```

除 `Canvas` 外，其余数组均可缺省（缺省视为空数组）。

### Canvas

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `Width` | number | 画布宽度，必须 > 0，非法时回退 800 |
| `Height` | number | 画布高度，必须 > 0，非法时回退 600 |
| `Background` | string | 背景色，见「颜色约定」 |

### Meta（可选）

`Title` / `Description` / `Author` / `CreatedAt` / `UpdatedAt`，纯元信息，运行时不参与渲染。

---

## 2. 属性值联合体（ValueRef）

图形所有可动画的数值与颜色属性都使用同一种结构：

```jsonc
{ "Const": 300 }        // 常量
{ "Const": "#FF0000" }  // 常量（颜色/文本）
{ "Bind": "GearAngle" } // 绑定变量
```

规则：

1. `Const` 支持 number / string / boolean；数值属性会强制转 number，无法转换时报错。
2. `Bind` 指向 `Variables[].Name`。变量不存在时运行时按 **0** 处理并给出告警（不抛异常）。
3. `Fill` / `Stroke` 为 `null` 或 `{ "Const": null }` 表示「不填充 / 不描边」。
4. 绑定不会改变图形定义本身：常量值仍保留在文档里，解除绑定后回落使用。

---

## 3. 变量表

```jsonc
{
  "Name": "RPM",
  "DefaultValue": 1200,
  "Description": "主动轴转速",
  "Min": 0,
  "Max": 3000,
  "Unit": "r/min",
  "Decimals": 0
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `Name` | 是 | 变量名，建议 `^[A-Za-z_][A-Za-z0-9_]*$`（表达式要引用它） |
| `DefaultValue` | 是 | 默认值（缺失为 0） |
| `Description` | 否 | 说明，用于上位机显示 |
| `Min` / `Max` | 否 | 值域，仅用于滑杆与钳制参考，运行时不强制钳制 |
| `Unit` | 否 | 单位 |
| `Decimals` | 否 | 显示小数位 |

变量名重复时保留首个定义并告警。

---

## 4. 图形

所有图形共享以下字段：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `Id` | string | — | 唯一标识（重复会自动重命名并告警） |
| `Name` | string | = Id | 显示名，交互事件里返回 |
| `Type` | string | — | `Line` / `Rectangle` / `Ellipse` / `Polygon` / `Path`，未知类型会被剔除 |
| `IsVisible` | bool | true | 可见性 |
| `ZIndex` | number | 0 | 层级，**值越大越靠上**；相同值按数组顺序 |
| `Opacity` | ValueRef | 1 | 不透明度 0..1（扩展字段） |
| `Fill` | ValueRef \| null | null | 填充 |
| `Stroke` | ValueRef \| null | null | 描边 |
| `StrokeThickness` | ValueRef | 1 | 线宽 |
| `LineCap` | string | `Flat` | `Flat` / `Round` / `Square`（扩展字段） |
| `LineJoin` | string | `Miter` | `Miter` / `Bevel` / `Round`（扩展字段） |
| `RenderTransform` | object | 无 | 变换，见下 |

> 「扩展字段」指 v1.0 的可选增量：缺省即恒等/默认行为，旧读取器忽略它们也不会画错。

### 4.1 RenderTransform

```jsonc
"RenderTransform": {
  "Rotate":    { "CenterX": {"Const":300}, "CenterY": {"Const":300}, "Value": {"Bind":"GearAngle"} },
  "Scale":     { "CenterX": {"Const":300}, "CenterY": {"Const":300}, "ValueX": {"Const":1}, "ValueY": {"Const":1} },
  "Translate": { "X": {"Const":0}, "Y": {"Const":0} }
}
```

**变换顺序固定为：缩放 → 旋转 → 平移**，缩放与旋转都绕 `CenterX/CenterY` 进行。

数学表达（p 为图形局部坐标）：

```
p' = T(Translate) · T(Center) · R(Angle) · S(Scale) · T(-Center) · p
```

对应 WPF：

```csharp
var m = Matrix.Identity;
m.ScaleAt(sx, sy, cx, cy);
m.RotateAt(angle, cx, cy);
m.Translate(tx, ty);
```

### 4.2 Line

```jsonc
{ "Type": "Line", "X1": {...}, "Y1": {...}, "X2": {...}, "Y2": {...} }
```

编辑器导出时会把旋转烘焙进端点（`RenderTransform` 为空），避免旋转中心歧义。

### 4.3 Rectangle

```jsonc
{ "Type": "Rectangle", "X": {...}, "Y": {...}, "Width": {...}, "Height": {...},
  "RadiusX": {...}, "RadiusY": {...} }
```

`X/Y` 是**未旋转时**的左上角；`RadiusX/Y` 为圆角半径（扩展字段，自动钳制到宽高的一半）。

### 4.4 Ellipse

```jsonc
{ "Type": "Ellipse", "CenterX": {...}, "CenterY": {...}, "RadiusX": {...}, "RadiusY": {...} }
```

### 4.5 Polygon

```jsonc
{ "Type": "Polygon",
  "Points": [ { "X": {"Const":0}, "Y": {"Const":0} }, ... ],
  "IsClosed": true }
```

顶点使用世界坐标；`IsClosed: false` 时为折线（不填充）。

### 4.6 Path

```jsonc
{ "Type": "Path", "Data": "M 10,10 L 110,10 L 110,60 Z", "OffsetX": 0, "OffsetY": 0 }
```

- `Data` 使用 **WPF Path Mini-Language**（`StreamGeometry` 语法）：`M/L/H/V/C/S/Q/T/A/Z`，支持 `F0` 前缀指定奇偶填充。
- 路径坐标是**局部坐标**，`OffsetX/OffsetY` 把局部原点平移到世界坐标。
- 旋转仍由 `RenderTransform.Rotate` 表达，中心点为世界坐标。
- 加载时会做严格字符校验（WPF 的 `Geometry.Parse` 对尾随垃圾字符过于宽容），非法路径整条剔除并报错。

---

## 5. 分组

```jsonc
{ "GroupId": "group_gear", "Name": "齿轮组件", "ShapeIds": ["gear_01"], "Visible": true,
  "Opacity": { "Const": 1 },
  "RenderTransform": { "Rotate": { "CenterX": { "Const": 300 }, "CenterY": { "Const": 300 },
                                  "Value": { "Bind": "GearAngle" } } },
  "Locked": false }
```

- 扁平结构，**一个图形最多属于一个分组**（重复归属会被忽略并告警）。
- 分组 `Visible=false` 时成员一并隐藏（与成员自身 `IsVisible` 取与）。
- `Opacity` 为扩展字段，与成员不透明度相乘。它是标准的 `ValueRef`，因此可以绑定变量；为了兼容手写文件，**裸数字**（如 `"Opacity": 0.4`）也会被读成 `{ "Const": 0.4 }`。
- `RenderTransform` 为扩展字段，作用在**每个成员自身变换之上**，顺序与图形一致：先平移，再绕 `CenterX/CenterY` 旋转，最后以同一中心缩放。字段结构与图形的 `RenderTransform` 完全相同，因此分组也可以绑定变量、被表达式/关键帧驱动。
- 编辑器里直接拖拽/缩放/旋转分组时，改动仍然**烘焙进成员几何**；分组 `RenderTransform` 是一层叠加的变换，默认是恒等（平移 0、旋转 0、缩放 1）。
- `Locked` 是编辑器语义，运行时忽略。

---

## 6. 表达式动画

```jsonc
{ "Id": "expr_gear_rotate", "TargetVariable": "GearAngle",
  "Expression": "RPM * 6 * t", "Enabled": true, "Wrap": 360 }
```

- 每帧（或每次外部写入）计算 `Expression`，结果写入 `TargetVariable`。
- 可用变量：`Variables` 中的全部变量名 + 时间 `t`（秒，从播放开始累计，暂停不累加）。
- `Wrap` 为扩展字段：结果对 `Wrap` 取欧几里得模（`mod(-30,360)=330`），常用于角度循环。
- 多个表达式之间存在依赖时，运行时会做**拓扑排序**，保证同一帧内先算被依赖者；检测到循环依赖会告警并降级。
- 目标变量若被外部写入，则本帧跳过（外部优先）。

### 6.1 表达式语法

| 优先级 | 运算符 |
| --- | --- |
| 低 | `? :`（三元） |
| ↓ | `\|\|` |
| ↓ | `&&` |
| ↓ | `==` `!=` |
| ↓ | `<` `<=` `>` `>=` |
| ↓ | `+` `-` |
| ↓ | `*` `/` `%` |
| ↓ | 一元 `-` `+` `!` |
| 高 | `^`（右结合，`2^3^2 = 512`） |

- 布尔以 `1/0` 表示，比较运算返回 `1/0`。
- 除零返回 `0`（不会产生 `Infinity`/`NaN`）。
- **不支持字符串字面量、不支持自定义函数**：词法阶段即拒绝，天然免疫注入。

### 6.2 函数白名单

| 函数 | 说明 |
| --- | --- |
| `sin cos tan` | 三角（**参数为度**） |
| `asin acos atan atan2` | 反三角（**返回度**） |
| `sqrt abs min max pow` | 基础数学 |
| `floor ceil round(x[,位数]) trunc sign` | 取整 |
| `exp ln log(x[,底]) log10` | 对数 |
| `clamp(v,lo,hi) lerp(a,b,t) mod(a,b)` | 区间/插值/取模 |
| `deg(rad) rad(deg)` | 角度换算 |
| `if(cond,a,b)` | 条件选择（等价三元） |

常量：`pi`、`e`、`true`、`false`。

> `mod(-30, 360) = 330`（结果恒非负）；`%` 是 C 风格取余（符号跟随被除数）。

---

## 7. 关键帧动画

```jsonc
{ "Id": "kf_pointer", "Name": "指示线扫描", "TargetVariable": "PointerX",
  "Loop": true,
  "Keyframes": [
    { "Time": 0, "Value": 380, "Easing": "EaseInOut" },
    { "Time": 2, "Value": 450, "Easing": "EaseInOut" },
    { "Time": 4, "Value": 380, "Easing": "EaseInOut" }
  ],
  "Enabled": true, "LoopDelay": 0 }
```

采样规则：

1. 关键帧按 `Time` 升序，**同一时间点保留最后一个**。
2. 时间早于首帧取首帧值；晚于末帧取末帧值。
3. 循环周期 = 末帧时间 + `LoopDelay`；落在延时区间内保持末帧值。
4. 缓动取自**起始关键帧**，作用到下一个关键帧：
   - `Linear`（默认）、`Step`（保持）、`EaseIn`（t²）、`EaseOut`（1-(1-t)²）、`EaseInOut`
5. `Enabled: false` 时整条动画被忽略。

---

## 8. 颜色约定

| 写法 | 解释 |
| --- | --- |
| `#AARRGGBB` | 8 位十六进制，**alpha 在前**（WPF 约定，编辑器输出此格式） |
| `#RRGGBB` / `#RGB` | 不透明 |
| `rgb(...)` / `rgba(r,g,b,a)` / `hsl(...)` | CSS 写法，解析兼容 |
| 命名颜色 | `Red`、`SteelBlue`、`transparent` … |
| 数值 | 按 `0xRRGGBB` 整数解释（**颜色绑定**专用，如 `0xFF0000` = 红） |

> ⚠️ 注意 CSS 的 8 位十六进制是 `#RRGGBBAA`（alpha 在后），与本文档约定不同。
> 编辑器在导出前统一转换为 `#AARRGGBB`；手写文件时请遵循 `#AARRGGBB`。

颜色绑定示例：

```jsonc
{ "Name": "LampColor", "DefaultValue": 65280 },   // 0x00FF00 绿
...
{ "Type": "Ellipse", "Fill": { "Bind": "LampColor" } }
```

---

## 9. 加载容错与校验

运行时的加载流程是「先规范化、再渲染」，所有修补都会记录为校验问题（`ValidationIssue`）：

| 情况 | 处理 |
| --- | --- |
| 缺少 `Id` | 自动生成 `shape_N` |
| `Id` 重复 | 重命名并告警 |
| 未知 `Type` | 剔除该图形并报错 |
| 路径非法 | 剔除该图形并报错 |
| 多边形顶点 < 2 | 剔除 |
| 分组引用不存在的图形 | 从分组中剔除 |
| 表达式语法错误 | 剔除该动画 |
| 变量重复定义 | 保留首个 |
| 画布尺寸非法 | 回退 800×600 |
| 变量不存在但被绑定 | 运行时按 0 处理 + 告警 |
| JSON 有注释/尾逗号 | 正常解析 |

---

## 10. 与编辑器的坐标转换约定

Fabric.js 内部以对象中心 + 缩放因子描述变换，而本 Schema 要求「真实几何 + 旋转」。编辑器的导出器做了三件事：

1. **烘焙缩放**：`width *= scaleX`、`radius *= scaleX/scaleY`、顶点按中心缩放、路径坐标整体缩放；
2. **保留旋转**：写成 `RenderTransform.Rotate{ CenterX, CenterY, Value }`，中心为世界坐标下的图形中心；
3. **烘焙平移**：直线直接改写端点；路径改写 `OffsetX/OffsetY`。

因此文档中**不会出现 `RenderTransform.Scale`**（除非手工编写或导入的 SVG 需要非等比缩放）。这样 WPF 端读到的 `Width`/`RadiusX` 永远是真实尺寸，属性面板也不会出现「宽度 10 但视觉是 40」的歧义。
