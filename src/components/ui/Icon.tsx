import {
  Video, PenLine, CheckSquare, MapPin,
  Code, Dumbbell, UtensilsCrossed, Users, User, ShoppingCart,
  BookOpen, Clapperboard, Feather, BookMarked,
  Smile, Frown, Target, Zap,
  Moon, ChevronLeft, Plus, Scissors, Trash2, ArrowLeft, ArrowRight,
  Play, Square, Sun, Circle, Contrast,
  X, RefreshCw, Settings,
  AlignLeft, AlignCenter, AlignRight,
  AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
  Bold, Type, Italic,
  Save, Download, Camera, LayoutDashboard, Film,
  type LucideIcon,
} from 'lucide-react-native';
import { colors } from '../../constants/theme';

export const ICONS = {
  // Capture types
  video: Video,
  penLine: PenLine,
  checkSquare: CheckSquare,
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
  camera: Camera,
  dashboard: LayoutDashboard,
  film: Film,
} as const;

export type IconName = keyof typeof ICONS;

type Props = {
  name: IconName;
  size?: number;
  color?: string;
};

export function Icon({ name, size = 18, color = colors.textMuted }: Props) {
  const IconComponent = ICONS[name];
  return <IconComponent size={size} color={color} strokeWidth={1.5} />;
}
