#!/usr/bin/env node
/**
 * Sample document generator.
 *
 * Generates samples/*.vectanim.json (the editor's initial sample and the WPF demo's sample).
 * Why a script instead of hand-written JSON: multi-vertex shapes like gears and fan blades
 * are error-prone to author by hand, and a script keeps the samples reproducible and
 * batch-adjustable.
 *
 * Usage: node tools/gen-samples.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const C = (value) => ({ Const: round(value) });
const Col = (value) => ({ Const: value });
const B = (name) => ({ Bind: name });

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function common(id, name, z, extra = {}) {
  return {
    Id: id,
    Name: name,
    IsVisible: true,
    ZIndex: z,
    Fill: null,
    Stroke: '#334155',
    StrokeThickness: C(1.5),
    ...extra,
  };
}

/** Generate the outline vertices of a gear */
function gearPoints(cx, cy, teeth, rootRadius, tipRadius, phase = 0) {
  const points = [];
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i += 1) {
    const a0 = phase + i * step;
    const a1 = a0 + step * 0.30;
    const a2 = a0 + step * 0.42;
    const a3 = a0 + step * 0.72;
    points.push({ X: C(cx + Math.cos(a0) * rootRadius), Y: C(cy + Math.sin(a0) * rootRadius) });
    points.push({ X: C(cx + Math.cos(a1) * tipRadius), Y: C(cy + Math.sin(a1) * tipRadius) });
    points.push({ X: C(cx + Math.cos(a2) * tipRadius), Y: C(cy + Math.sin(a2) * tipRadius) });
    points.push({ X: C(cx + Math.cos(a3) * rootRadius), Y: C(cy + Math.sin(a3) * rootRadius) });
  }
  return points;
}

/** Generate a single fan blade (sector polygon); phaseRad is the blade orientation */
function bladePoints(cx, cy, innerRadius, outerRadius, spreadDeg, phaseRad) {
  const points = [];
  const half = (spreadDeg * Math.PI) / 360;
  const steps = 8;
  for (let i = 0; i <= steps; i += 1) {
    const a = phaseRad - half + (2 * half * i) / steps;
    points.push({ X: C(cx + Math.cos(a) * outerRadius), Y: C(cy + Math.sin(a) * outerRadius) });
  }
  for (let i = steps; i >= 0; i -= 1) {
    const a = phaseRad - half * 0.45 + (2 * half * 0.45 * i) / steps;
    points.push({ X: C(cx + Math.cos(a) * innerRadius), Y: C(cy + Math.sin(a) * innerRadius) });
  }
  return points;
}

/* ---------------------------------------------------------------------- *
 * Sample 1: gear drive (the gear-demo from the requirements document)
 * ---------------------------------------------------------------------- */

function gearDemo() {
  const centerX = 300;
  const centerY = 300;
  const drivenX = 450;
  const drivenY = 300;

  return {
    SchemaVersion: '1.0',
    Canvas: { Width: 800, Height: 600, Background: '#FFFFFFFF' },
    Variables: [
      { Name: 'RPM', DefaultValue: 1200, Description: 'Drive shaft speed', Min: 0, Max: 3000, Unit: 'r/min' },
      { Name: 'GearAngle', DefaultValue: 0, Description: 'Drive gear angle', Min: 0, Max: 360, Unit: '°' },
      { Name: 'DrivenAngle', DefaultValue: 0, Description: 'Driven gear angle', Min: 0, Max: 360, Unit: '°' },
      { Name: 'PointerX', DefaultValue: 380, Description: 'Pointer line end X', Min: 300, Max: 470 },
      { Name: 'PointerY', DefaultValue: 150, Description: 'Pointer line end Y', Min: 60, Max: 300 },
      { Name: 'LampColor', DefaultValue: 65280, Description: 'Status lamp color (0xRRGGBB)', Min: 0, Max: 16777215 },
      { Name: 'Temp', DefaultValue: 45, Description: 'Bearing temperature', Min: 0, Max: 120, Unit: '℃' },
      { Name: 'TempBarHeight', DefaultValue: 0, Description: 'Temperature bar height (expression)', Min: 0, Max: 200 },
      { Name: 'TempBarY', DefaultValue: 0, Description: 'Temperature bar top Y (expression)', Min: 0, Max: 600 },
    ],
    Shapes: [
      {
        ...common('bg_frame', 'Backplate', 0, {
          Fill: Col('#F8FAFC'),
          Stroke: Col('#CBD5E1'),
          StrokeThickness: C(2),
        }),
        Type: 'Rectangle',
        X: C(40),
        Y: C(40),
        Width: C(720),
        Height: C(520),
        RadiusX: C(14),
        RadiusY: C(14),
      },
      {
        ...common('gear_01', 'Drive gear', 20, {
          Fill: Col('#E2E8F0'),
          Stroke: Col('#1E293B'),
          StrokeThickness: C(2),
        }),
        Type: 'Polygon',
        Points: gearPoints(centerX, centerY, 12, 70, 86),
        IsClosed: true,
        RenderTransform: {
          Rotate: { CenterX: C(centerX), CenterY: C(centerY), Value: B('GearAngle') },
        },
      },
      {
        ...common('gear_02', 'Driven gear', 18, {
          Fill: Col('#F1F5F9'),
          Stroke: Col('#1E293B'),
          StrokeThickness: C(2),
        }),
        Type: 'Polygon',
        Points: gearPoints(drivenX, drivenY, 8, 50, 64, 0.22),
        IsClosed: true,
        RenderTransform: {
          Rotate: { CenterX: C(drivenX), CenterY: C(drivenY), Value: B('DrivenAngle') },
        },
      },
      {
        ...common('hub_01', 'Drive shaft', 30, {
          Fill: Col('#94A3B8'),
          Stroke: Col('#0F172A'),
          StrokeThickness: C(1.5),
        }),
        Type: 'Ellipse',
        CenterX: C(centerX),
        CenterY: C(centerY),
        RadiusX: C(22),
        RadiusY: C(22),
      },
      {
        ...common('key_01', 'Keyway marker', 32, {
          Fill: Col('#0EA5E9'),
          Stroke: Col('#0369A1'),
          StrokeThickness: C(1),
        }),
        Type: 'Rectangle',
        X: C(centerX - 6),
        Y: C(centerY - 62),
        Width: C(12),
        Height: C(22),
        RadiusX: C(3),
        RadiusY: C(3),
        RenderTransform: {
          Rotate: { CenterX: C(centerX), CenterY: C(centerY), Value: B('GearAngle') },
        },
      },
      {
        ...common('line_01', 'Pointer line', 40, {
          Fill: null,
          Stroke: Col('#EF4444'),
          StrokeThickness: C(2),
          LineCap: 'Round',
        }),
        Type: 'Line',
        X1: C(centerX),
        Y1: C(centerY),
        X2: B('PointerX'),
        Y2: B('PointerY'),
      },
      {
        ...common('lamp_01', 'Status lamp', 50, {
          Fill: B('LampColor'),
          Stroke: Col('#0F172A'),
          StrokeThickness: C(2),
        }),
        Type: 'Ellipse',
        CenterX: C(680),
        CenterY: C(110),
        RadiusX: C(26),
        RadiusY: C(26),
      },
      {
        ...common('temp_track', 'Temperature bar track', 10, {
          Fill: Col('#E2E8F0'),
          Stroke: Col('#94A3B8'),
          StrokeThickness: C(1),
        }),
        Type: 'Rectangle',
        X: C(90),
        Y: C(430),
        Width: C(60),
        Height: C(100),
        RadiusX: C(6),
        RadiusY: C(6),
      },
      {
        ...common('temp_bar', 'Temperature bar', 12, {
          Fill: Col('#F59E0B'),
          Stroke: null,
          StrokeThickness: C(0),
        }),
        Type: 'Rectangle',
        X: C(90),
        Y: B('TempBarY'),
        Width: C(60),
        Height: B('TempBarHeight'),
        RadiusX: C(6),
        RadiusY: C(6),
      },
      {
        ...common('pipe_01', 'Piping', 5, {
          Fill: null,
          Stroke: Col('#475569'),
          StrokeThickness: C(6),
          LineCap: 'Round',
        }),
        Type: 'Path',
        Data: 'M 60,300 C 110,300 120,470 150,470',
        OffsetX: 0,
        OffsetY: 0,
      },
    ],
    ExpressionAnimations: [
      {
        Id: 'expr_gear_rotate',
        TargetVariable: 'GearAngle',
        Expression: 'RPM * 6 * t',
        Enabled: true,
        Wrap: 360,
      },
      {
        Id: 'expr_driven_rotate',
        TargetVariable: 'DrivenAngle',
        Expression: 'GearAngle * -1.5',
        Enabled: true,
        Wrap: 360,
      },
      {
        Id: 'expr_temp_bar',
        TargetVariable: 'TempBarHeight',
        Expression: 'clamp(Temp, 0, 120) / 120 * 100',
        Enabled: true,
      },
      {
        Id: 'expr_temp_y',
        TargetVariable: 'TempBarY',
        Expression: '530 - clamp(Temp, 0, 120) / 120 * 100',
        Enabled: true,
      },
    ],
    KeyframeAnimations: [
      {
        Id: 'kf_pointer',
        Name: 'Pointer sweep',
        TargetVariable: 'PointerX',
        Loop: true,
        Keyframes: [
          { Time: 0, Value: 380, Easing: 'EaseInOut' },
          { Time: 2, Value: 450, Easing: 'EaseInOut' },
          { Time: 4, Value: 380, Easing: 'EaseInOut' },
        ],
      },
    ],
    Groups: [
      {
        GroupId: 'group_gear',
        Name: 'Gear assembly',
        ShapeIds: ['gear_01', 'gear_02', 'hub_01', 'key_01'],
        Visible: true,
      },
      {
        GroupId: 'group_gauge',
        Name: 'Gauge assembly',
        ShapeIds: ['temp_track', 'temp_bar'],
        Visible: true,
      },
    ],
    Meta: {
      Title: 'Gear drive demo',
      Description: 'Expression animations spin the gears, keyframes drive the pointer line, numeric color drives the status lamp',
      Author: 'VectAnim',
      CreatedAt: new Date().toISOString(),
      UpdatedAt: new Date().toISOString(),
    },
  };
}

/* ---------------------------------------------------------------------- *
 * Sample 2: industrial HMI panel
 * ---------------------------------------------------------------------- */

function industrialPanel() {
  const fanCx = 700;
  const fanCy = 200;
  const bladeShapes = [0, 1, 2, 3].map((index) => {
    const phase = (Math.PI / 2) * index + 0.2;
    return {
      ...common(`fan_blade_${index + 1}`, `Fan blade ${index + 1}`, 20 + index, {
        Fill: Col('#38BDF8'),
        Stroke: Col('#0EA5E9'),
        StrokeThickness: C(1),
        Opacity: C(0.85),
      }),
      Type: 'Polygon',
      Points: bladePoints(fanCx, fanCy, 14, 54, 34, phase),
      IsClosed: true,
      RenderTransform: {
        Rotate: { CenterX: C(fanCx), CenterY: C(fanCy), Value: B('FanAngle') },
      },
    };
  });

  return {
    SchemaVersion: '1.0',
    Canvas: { Width: 960, Height: 600, Background: '#0B1220FF' },
    Variables: [
      { Name: 'MotorRPM', DefaultValue: 900, Description: 'Motor speed', Min: 0, Max: 1800, Unit: 'r/min' },
      { Name: 'FanAngle', DefaultValue: 0, Description: 'Fan angle', Min: 0, Max: 360, Unit: '°' },
      { Name: 'TankLevel', DefaultValue: 62, Description: 'Liquid level', Min: 0, Max: 100, Unit: '%' },
      { Name: 'LevelHeight', DefaultValue: 0, Description: 'Level height (expression)', Min: 0, Max: 240 },
      { Name: 'LevelY', DefaultValue: 0, Description: 'Level top Y (expression)', Min: 0, Max: 600 },
      { Name: 'Alarm', DefaultValue: 0, Description: 'Alarm (0/1)', Min: 0, Max: 1 },
      { Name: 'LampColor', DefaultValue: 65280, Description: 'Alarm lamp color', Min: 0, Max: 16777215 },
      { Name: 'ConveyorPos', DefaultValue: 428, Description: 'Material offset', Min: 420, Max: 710 },
      { Name: 'NeedleAngle', DefaultValue: 0, Description: 'Needle angle', Min: -120, Max: 120, Unit: '°' },
      { Name: 'Pressure', DefaultValue: 0.6, Description: 'Pressure', Min: 0, Max: 1.6, Unit: 'MPa' },
    ],
    Shapes: [
      {
        ...common('panel_bg', 'Panel background', 0, { Fill: Col('#111C2E'), Stroke: Col('#1E3A5F'), StrokeThickness: C(1.5) }),
        Type: 'Rectangle',
        X: C(20), Y: C(20), Width: C(920), Height: C(560),
        RadiusX: C(10), RadiusY: C(10),
      },
      {
        ...common('tank_body', 'Tank', 10, { Fill: Col('#16233A'), Stroke: Col('#2D4B73'), StrokeThickness: C(2) }),
        Type: 'Rectangle',
        X: C(70), Y: C(280), Width: C(180), Height: C(240),
        RadiusX: C(16), RadiusY: C(16),
      },
      {
        ...common('tank_liquid', 'Liquid level', 12, { Fill: Col('#0EA5E9'), Stroke: null, StrokeThickness: C(0), Opacity: C(0.85) }),
        Type: 'Rectangle',
        X: C(74), Y: B('LevelY'), Width: C(172), Height: B('LevelHeight'),
        RadiusX: C(12), RadiusY: C(12),
      },
      {
        ...common('tank_cap', 'Tank cap', 14, { Fill: Col('#1E3A5F'), Stroke: Col('#2D4B73'), StrokeThickness: C(1.5) }),
        Type: 'Ellipse',
        CenterX: C(160), CenterY: C(280), RadiusX: C(90), RadiusY: C(16),
      },
      {
        ...common('pipe_main', 'Main piping', 8, { Fill: null, Stroke: Col('#33517A'), StrokeThickness: C(8), LineCap: 'Round' }),
        Type: 'Path',
        Data: 'M 250,470 L 330,470 L 330,320 L 420,320',
        OffsetX: 0, OffsetY: 0,
      },
      ...bladeShapes,
      {
        ...common('fan_hub', 'Fan hub', 26, { Fill: Col('#1E3A5F'), Stroke: Col('#38BDF8'), StrokeThickness: C(1.5) }),
        Type: 'Ellipse',
        CenterX: C(fanCx), CenterY: C(fanCy), RadiusX: C(12), RadiusY: C(12),
      },
      {
        ...common('alarm_ring', 'Alarm lamp base', 28, { Fill: null, Stroke: Col('#33517A'), StrokeThickness: C(2) }),
        Type: 'Ellipse',
        CenterX: C(860), CenterY: C(70), RadiusX: C(26), RadiusY: C(26),
      },
      {
        ...common('alarm_lamp', 'Alarm lamp', 30, {
          Fill: B('LampColor'), Stroke: Col('#1E3A5F'), StrokeThickness: C(2), Opacity: C(0.95),
        }),
        Type: 'Ellipse',
        CenterX: C(860), CenterY: C(70), RadiusX: C(18), RadiusY: C(18),
      },
      {
        ...common('gauge_dial', 'Gauge dial', 40, { Fill: Col('#0F1A2C'), Stroke: Col('#2D4B73'), StrokeThickness: C(2) }),
        Type: 'Ellipse',
        CenterX: C(620), CenterY: C(430), RadiusX: C(80), RadiusY: C(80),
      },
      {
        ...common('gauge_arc', 'Gauge scale arc', 41, {
          Fill: null, Stroke: Col('#38BDF8'), StrokeThickness: C(3), LineCap: 'Round',
        }),
        Type: 'Path',
        Data: 'M 556,478 A 80,80 0 0 1 684,478',
        OffsetX: 0, OffsetY: 0,
      },
      {
        ...common('gauge_needle', 'Pressure needle', 44, {
          Fill: null, Stroke: Col('#F97316'), StrokeThickness: C(3), LineCap: 'Round',
        }),
        Type: 'Line',
        X1: C(620), Y1: C(430), X2: C(620), Y2: C(360),
        RenderTransform: { Rotate: { CenterX: C(620), CenterY: C(430), Value: B('NeedleAngle') } },
      },
      {
        ...common('gauge_hub', 'Gauge hub', 46, { Fill: Col('#F97316'), Stroke: null, StrokeThickness: C(0) }),
        Type: 'Ellipse',
        CenterX: C(620), CenterY: C(430), RadiusX: C(6), RadiusY: C(6),
      },
      {
        ...common('conveyor', 'Conveyor belt', 50, { Fill: Col('#16233A'), Stroke: Col('#2D4B73'), StrokeThickness: C(2) }),
        Type: 'Rectangle',
        X: C(420), Y: C(150), Width: C(320), Height: C(36),
        RadiusX: C(18), RadiusY: C(18),
      },
      {
        ...common('conveyor_marker', 'Material', 52, { Fill: Col('#FBBF24'), Stroke: Col('#B45309'), StrokeThickness: C(1) }),
        Type: 'Rectangle',
        X: B('ConveyorPos'), Y: C(158), Width: C(28), Height: C(20),
        RadiusX: C(4), RadiusY: C(4),
      },
    ],
    ExpressionAnimations: [
      { Id: 'expr_fan', TargetVariable: 'FanAngle', Expression: 'MotorRPM * 6 * t', Enabled: true, Wrap: 360 },
      { Id: 'expr_level_h', TargetVariable: 'LevelHeight', Expression: 'clamp(TankLevel, 0, 100) / 100 * 236', Enabled: true },
      { Id: 'expr_level_y', TargetVariable: 'LevelY', Expression: '516 - clamp(TankLevel, 0, 100) / 100 * 236', Enabled: true },
      { Id: 'expr_needle', TargetVariable: 'NeedleAngle', Expression: 'clamp(Pressure / 1.6, 0, 1) * 240 - 120', Enabled: true },
      { Id: 'expr_lamp', TargetVariable: 'LampColor', Expression: 'if(Alarm > 0.5, 16711680, 65280)', Enabled: true },
    ],
    KeyframeAnimations: [
      {
        Id: 'kf_conveyor',
        Name: 'Material transport',
        TargetVariable: 'ConveyorPos',
        Loop: true,
        Keyframes: [
          { Time: 0, Value: 428 },
          { Time: 3, Value: 704 },
        ],
      },
    ],
    Groups: [
      { GroupId: 'group_tank', Name: 'Tank', ShapeIds: ['tank_body', 'tank_liquid', 'tank_cap'], Visible: true },
      { GroupId: 'group_fan', Name: 'Fan', ShapeIds: ['fan_blade_1', 'fan_blade_2', 'fan_blade_3', 'fan_blade_4', 'fan_hub'], Visible: true },
      { GroupId: 'group_gauge', Name: 'Pressure gauge', ShapeIds: ['gauge_dial', 'gauge_arc', 'gauge_needle', 'gauge_hub'], Visible: true },
      { GroupId: 'group_alarm', Name: 'Alarm', ShapeIds: ['alarm_lamp', 'alarm_ring'], Visible: true },
    ],
    Meta: {
      Title: 'Industrial HMI panel sample',
      Description: 'Level, fan, pressure gauge and alarm lamp are all variable-driven; demonstrates chained expression dependencies and numeric color bindings',
      Author: 'VectAnim',
      CreatedAt: new Date().toISOString(),
      UpdatedAt: new Date().toISOString(),
    },
  };
}

/* ---------------------------------------------------------------------- */

mkdirSync(resolve(root, 'samples'), { recursive: true });

const outputs = [
  ['samples/gear-demo.vectanim.json', gearDemo()],
  ['samples/industrial-panel.vectanim.json', industrialPanel()],
];

for (const [file, doc] of outputs) {
  writeFileSync(resolve(root, file), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  console.log(`written ${file}  (${doc.Shapes.length} shapes, ${doc.Variables.length} vars)`);
}
