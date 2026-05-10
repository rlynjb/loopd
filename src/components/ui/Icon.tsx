import {
  Video, PenLine, CheckSquare, ListTodo, MapPin,
  Code, Dumbbell, UtensilsCrossed, Users, User, ShoppingCart,
  BookOpen, Clapperboard, Feather, BookMarked,
  Smile, Frown, Target, Zap,
  Moon, ChevronLeft, Plus, Scissors, Trash2, ArrowLeft, ArrowRight, ArrowUp, ArrowDown,
  Play, Square, Sun, Circle, Contrast,
  X, RefreshCw, Settings,
  AlignLeft, AlignCenter, AlignRight,
  AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
  Bold, Type, Italic,
  Save, Download, Upload, Camera, LayoutDashboard, Film,
  House,
  Lightbulb, Bug, HelpCircle, GitBranch, GraduationCap, Eye,
  Pin, PinOff,
  Sparkles,
  type LucideIcon,
} from 'lucide-react-native';
import { colors } from '../../constants/theme';

export const ICONS = {
  // Capture types
  video: Video,
  penLine: PenLine,
  checkSquare: CheckSquare,
  listTodo: ListTodo,
  mapPin: MapPin,
  // Categories
  code: Code,
  dumbbell: Dumbbell,
  utensils: UtensilsCrossed,
  users: Users,
  user: User,
  shoppingCart: ShoppingCart,
  // Habits
  bookOpen: BookOpen,
  clapperboard: Clapperboard,
  feather: Feather,
  bookMarked: BookMarked,
  // Moods
  smile: Smile,
  frown: Frown,
  target: Target,
  zap: Zap,
  // UI
  moon: Moon,
  chevronLeft: ChevronLeft,
  plus: Plus,
  scissors: Scissors,
  trash: Trash2,
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  play: Play,
  square: Square,
  sun: Sun,
  circle: Circle,
  contrast: Contrast,
  x: X,
  refresh: RefreshCw,
  settings: Settings,
  alignLeft: AlignLeft,
  alignCenter: AlignCenter,
  alignRight: AlignRight,
  posTop: AlignVerticalJustifyStart,
  posCenter: AlignVerticalJustifyCenter,
  posBottom: AlignVerticalJustifyEnd,
  bold: Bold,
  type: Type,
  thin: Italic,
  save: Save,
  download: Download,
  upload: Upload,
  camera: Camera,
  dashboard: LayoutDashboard,
  film: Film,
  house: House,
  // Thinking-mode badges
  lightbulb: Lightbulb,
  bug: Bug,
  helpCircle: HelpCircle,
  gitBranch: GitBranch,
  graduationCap: GraduationCap,
  eye: Eye,
  // Pin / unpin
  pin: Pin,
  pinOff: PinOff,
  // AI / interpret
  sparkles: Sparkles,
} as const;

export type IconName = keyof typeof ICONS;

type Props = {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  /** SVG fill color — pass to render solid/filled variants of an outline
   *  icon (e.g. a filled pin). Defaults to 'none' which keeps the icon
   *  outline-only. */
  fill?: string;
};

export function Icon({ name, size = 18, color = colors.textMuted, strokeWidth = 1.5, fill = 'none' }: Props) {
  const IconComponent = ICONS[name];
  return <IconComponent size={size} color={color} strokeWidth={strokeWidth} fill={fill} />;
}
