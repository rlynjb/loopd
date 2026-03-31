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
  fontWeight: number;
  italic?: boolean;
  lineHeight?: number;
  color: string;
  textAlign?: 'left' | 'center' | 'right';
  position?: 'top' | 'center' | 'bottom';
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

export type ExportStage = 'preparing' | 'encoding' | 'finalizing' | 'done' | 'error';

export type ExportProgress = {
  stage: ExportStage;
  progress: number;
  currentTimeMs: number;
  totalDurationMs: number;
  error?: string;
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
