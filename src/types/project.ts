export type ClipItem = {
  id: string;
  entryId: string;
  clipUri: string;
  caption: string;
  durationMs: number;
  trimStartPct: number;
  trimEndPct: number;
  order: number;
  color: string;
};

export type TextOverlay = {
  id: string;
  text: string;
  startPct: number;
  endPct: number;
  fontSize: number;
  fontWeight: 300 | 400 | 700;
  color: string;
};

export type FilterOverlay = {
  id: string;
  filterId: string;
  startPct: number;
  endPct: number;
  brightness: number;
  contrast: number;
  saturate: number;
};

export type EditorProject = {
  id: string;
  date: string;
  status: 'draft' | 'exported';
  clips: ClipItem[];
  textOverlays: TextOverlay[];
  filterOverlays: FilterOverlay[];
  exportUri: string | null;
  updatedAt: string;
};
