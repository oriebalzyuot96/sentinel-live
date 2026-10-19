import type { CameraInfo, SceneKind } from './protocol';

/** Fixed camera roster used by both the server and the in-browser simulator. */
export const CAMERAS: CameraInfo[] = [
  {
    id: 'cam-01',
    name: 'North Gate',
    nameAr: 'البوابة الشمالية',
    scene: 'street',
    zones: [{ id: 'gate-a', label: 'Gate A', polygon: [[0.76, 0.43], [0.97, 0.43], [0.98, 0.54], [0.74, 0.54]] }],
    lines: [{ id: 'crosswalk', label: 'Crosswalk', a: [0.44, 0.75], b: [0.38, 0.99] }],
  },
  {
    id: 'cam-02',
    name: 'Main Lobby',
    nameAr: 'الردهة الرئيسية',
    scene: 'lobby',
    zones: [{ id: 'staff', label: 'Staff only', polygon: [[0.04, 0.44], [0.3, 0.44], [0.28, 0.64], [0.04, 0.64]] }],
    lines: [{ id: 'entrance', label: 'Entrance', a: [0.5, 0.82], b: [0.9, 0.82] }],
  },
  {
    id: 'cam-03',
    name: 'Parking P2',
    nameAr: 'موقف P2',
    scene: 'parking',
    zones: [{ id: 'bay', label: 'Restricted bay', polygon: [[0.7, 0.84], [0.97, 0.84], [0.97, 0.99], [0.66, 0.99]] }],
    lines: [{ id: 'exit', label: 'Exit ramp', a: [0.16, 0.54], b: [0.16, 0.8] }],
  },
  {
    id: 'cam-04',
    name: 'Platform B',
    nameAr: 'الرصيف B',
    scene: 'platform',
    zones: [{ id: 'edge', label: 'Track edge', polygon: [[0.02, 0.91], [0.98, 0.91], [0.98, 0.995], [0.02, 0.995]] }],
    lines: [{ id: 'gateline', label: 'Ticket gates', a: [0.5, 0.48], b: [0.5, 0.7] }],
  },
  {
    id: 'cam-05',
    name: 'East Plaza',
    nameAr: 'الساحة الشرقية',
    scene: 'street',
    zones: [{ id: 'kiosk', label: 'Kiosk', polygon: [[0.06, 0.78], [0.26, 0.78], [0.28, 0.96], [0.04, 0.96]] }],
    lines: [{ id: 'kerb', label: 'Kerb', a: [0.62, 0.43], b: [0.58, 0.54] }],
  },
  {
    id: 'cam-06',
    name: 'Service Dock',
    nameAr: 'رصيف الخدمات',
    scene: 'parking',
    zones: [{ id: 'loading', label: 'Loading zone', polygon: [[0.04, 0.84], [0.32, 0.84], [0.34, 0.99], [0.02, 0.99]] }],
    lines: [{ id: 'barrier', label: 'Barrier', a: [0.84, 0.54], b: [0.84, 0.8] }],
  },
];

export interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface Lane {
  y: number;
  dir: 1 | -1;
}

export interface SceneLayout {
  walk: Rect[];
  lanes: Lane[];
  persons: number;
  vehicles: number;
  crowdThreshold: number;
}

export const SCENE_LAYOUT: Record<SceneKind, SceneLayout> = {
  street: {
    walk: [
      { x0: 0.02, x1: 0.98, y0: 0.44, y1: 0.53 },
      { x0: 0.02, x1: 0.98, y0: 0.76, y1: 0.98 },
    ],
    lanes: [
      { y: 0.62, dir: 1 },
      { y: 0.7, dir: -1 },
    ],
    persons: 6,
    vehicles: 2,
    crowdThreshold: 9,
  },
  lobby: {
    walk: [{ x0: 0.05, x1: 0.95, y0: 0.45, y1: 0.98 }],
    lanes: [],
    persons: 7,
    vehicles: 0,
    crowdThreshold: 9,
  },
  parking: {
    walk: [
      { x0: 0.02, x1: 0.98, y0: 0.85, y1: 0.98 },
      { x0: 0.02, x1: 0.98, y0: 0.44, y1: 0.5 },
    ],
    lanes: [
      { y: 0.6, dir: 1 },
      { y: 0.75, dir: -1 },
    ],
    persons: 3,
    vehicles: 3,
    crowdThreshold: 8,
  },
  platform: {
    walk: [{ x0: 0.04, x1: 0.96, y0: 0.48, y1: 0.95 }],
    lanes: [],
    persons: 9,
    vehicles: 0,
    crowdThreshold: 10,
  },
};
