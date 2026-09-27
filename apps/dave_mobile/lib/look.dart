import 'package:flutter/cupertino.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The two looks the trader can switch between -- Midnight Lime (dark) and Pearl (light) (Settings -> Appearance). A look is more than a
/// palette: it also picks how Home is laid out. Every screen reads colours from [Look.of], so a
/// switch repaints the whole app at once.

enum HomeLayout {
  /// A grid of tiles: balance with round actions, open P&L, a win-rate ring.
  bento,

  /// Huge numbers and a row of plain KPIs, like a finance magazine.
  editorial,
}

class Look {
  const Look({
    required this.id,
    required this.name,
    required this.blurb,
    required this.brightness,
    required this.base,
    required this.orbs,
    required this.card,
    required this.line,
    required this.chip,
    required this.accent,
    required this.accent2,
    required this.up,
    required this.down,
    required this.bar,
    required this.tabIdle,
    required this.tabIcon,
    required this.tabActive,
    required this.tabActiveIcon,
    required this.me,
    required this.meText,
    required this.hero,
    required this.heroText,
    required this.layout,
  });

  final String id;
  final String name;
  final String blurb;
  final Brightness brightness;

  /// The screen background, and soft colour glows laid over it.
  final Color base;
  final List<(Alignment, Color, double)> orbs;

  /// Panels, their hairline edge, and small pills/chips.
  final Color card;
  final Color line;
  final Color chip;

  /// The look's one strong colour, and a second one for information from elsewhere (Nous).
  final Color accent;
  final Color accent2;
  final Color up;
  final Color down;

  /// The floating bottom bar and its round buttons.
  final Color bar;
  final Color tabIdle;
  final Color tabIcon;
  final Color tabActive;
  final Color tabActiveIcon;

  /// The trader's own chat bubble.
  final Gradient me;
  final Color meText;

  /// The big coloured card (Home's sheet, Live's "now").
  final Gradient hero;
  final Color heroText;
  final HomeLayout layout;

  bool get dark => brightness == Brightness.dark;

  static Look of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<LookScope>()?.notifier?.value ?? midnightLime;

  static const midnightLime = Look(
    id: 'midnight-lime',
    name: 'Midnight Lime',
    blurb: 'Pure black, one lime accent, a grid of tiles.',
    brightness: Brightness.dark,
    base: Color(0xFF050505),
    orbs: [(Alignment(-1.2, -1.1), Color(0xFF6E8F2A), 0.22), (Alignment(1.2, 1.2), Color(0xFF2F4A12), 0.25)],
    card: Color(0xFF101213),
    line: Color(0xFF1F2224),
    chip: Color(0xFF16181A),
    accent: Color(0xFFC6F36B),
    accent2: Color(0xFFC6F36B),
    up: Color(0xFF8BF06B),
    down: Color(0xFFFF6B6B),
    bar: Color(0xEB141618),
    tabIdle: Color(0xFF1D2022),
    tabIcon: Color(0xFFF4F5F0),
    tabActive: Color(0xFFC6F36B),
    tabActiveIcon: Color(0xFF0D1405),
    me: LinearGradient(colors: [Color(0xFFC6F36B), Color(0xFFB2E655)]),
    meText: Color(0xFF0D1405),
    hero: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [Color(0xFF1E2A10), Color(0xFF101213)]),
    heroText: Color(0xFFF4F5F0),
    layout: HomeLayout.bento,
  );

  static const pearl = Look(
    id: 'pearl',
    name: 'Pearl',
    blurb: 'Light and editorial: huge numbers, one orange accent.',
    brightness: Brightness.light,
    base: Color(0xFFF7F5F1),
    orbs: [(Alignment(1.2, -1.1), Color(0xFFFFD9C2), 0.45)],
    card: Color(0xFFFFFFFF),
    line: Color(0xFFE6E1D8),
    chip: Color(0xFFECE8E1),
    accent: Color(0xFFFF6A2B),
    accent2: Color(0xFFFF6A2B),
    up: Color(0xFF16A36A),
    down: Color(0xFFE5484D),
    bar: Color(0xFF141414),
    tabIdle: Color(0xFF262624),
    tabIcon: Color(0xFFF7F5F1),
    tabActive: Color(0xFFFFFFFF),
    tabActiveIcon: Color(0xFF141414),
    me: LinearGradient(colors: [Color(0xFF141414), Color(0xFF2A2A28)]),
    meText: Color(0xFFFFFFFF),
    hero: LinearGradient(colors: [Color(0xFF141414), Color(0xFF1F1E1C)]),
    heroText: Color(0xFFF7F5F1),
    layout: HomeLayout.editorial,
  );

  static const all = [midnightLime, pearl];

  static Look byId(String? id) => all.firstWhere((l) => l.id == id, orElse: () => midnightLime);
}

/// Holds the chosen look and remembers it on the phone.
class LookController extends ValueNotifier<Look> {
  LookController([super.value = Look.midnightLime]);

  static const _key = 'dave.look';

  Future<void> load() async {
    try {
      value = Look.byId(await SharedPreferencesAsync().getString(_key));
    } catch (_) {
      // no saved choice (or no storage in tests) -- keep the default
    }
  }

  Future<void> choose(Look look) async {
    value = look;
    try {
      await SharedPreferencesAsync().setString(_key, look.id);
    } catch (_) {}
  }
}

class LookScope extends InheritedNotifier<LookController> {
  const LookScope({super.key, required LookController controller, required super.child}) : super(notifier: controller);

  static LookController? controllerOf(BuildContext context) => context.dependOnInheritedWidgetOfExactType<LookScope>()?.notifier;
}
