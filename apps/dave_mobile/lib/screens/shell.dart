import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import '../theme.dart';
import 'brain.dart';
import 'home.dart';
import 'settings.dart';
import 'skills.dart';

class _Tab {
  const _Tab(this.label, this.icon, this.activeIcon);
  final String label;
  final IconData icon;
  final IconData activeIcon;
}

const _tabs = [
  _Tab('Home', CupertinoIcons.chart_bar_square, CupertinoIcons.chart_bar_square_fill),
  _Tab('Brain', CupertinoIcons.lightbulb, CupertinoIcons.lightbulb_fill),
  _Tab('Skills', CupertinoIcons.square_stack_3d_up, CupertinoIcons.square_stack_3d_up_fill),
  _Tab('Settings', CupertinoIcons.gear_alt, CupertinoIcons.gear_alt_fill),
];

/// The app frame: four screens and the floating tab bar.
///
/// The tab bar is the iOS 26 pattern -- a floating glass capsule inset from the screen edges,
/// anchored at the bottom where the thumb already is, rather than a flat full-width bar. It is the
/// one piece of glass in the app apart from the navigation bar; content never wears glass.
///
/// Screens live in an IndexedStack so switching tabs keeps each one's scroll position and loaded
/// data -- the HIG rule that a tab switch never loses your place.
class Shell extends StatefulWidget {
  const Shell({super.key});

  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> {
  int _index = 0;

  static const _pages = [HomeScreen(), BrainScreen(), SkillsScreen(), SettingsScreen()];

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.paddingOf(context).bottom;
    return Stack(children: [
      Positioned.fill(child: IndexedStack(index: _index, children: _pages)),
      Positioned(
        left: 21,
        right: 21,
        bottom: bottom + 12,
        child: Glass(
          radius: 32,
          child: SizedBox(
            height: 62,
            child: Row(children: [
              for (var i = 0; i < _tabs.length; i++)
                Expanded(
                  child: _TabButton(
                    tab: _tabs[i],
                    selected: i == _index,
                    onTap: () {
                      if (i == _index) return;
                      HapticFeedback.selectionClick();
                      setState(() => _index = i);
                    },
                  ),
                ),
            ]),
          ),
        ),
      ),
    ]);
  }
}

class _TabButton extends StatelessWidget {
  const _TabButton({required this.tab, required this.selected, required this.onTap});
  final _Tab tab;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final accent = resolve(context, CupertinoColors.systemBlue);
    final idle = resolve(context, CupertinoColors.secondaryLabel);
    final color = selected ? accent : idle;
    return Semantics(
      button: true,
      selected: selected,
      label: tab.label,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(5),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            curve: Curves.easeOut,
            decoration: BoxDecoration(
              color: selected ? accent.withValues(alpha: 0.12) : const Color(0x00000000),
              borderRadius: BorderRadius.circular(26),
            ),
            child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
              Icon(selected ? tab.activeIcon : tab.icon, size: 22, color: color),
              const SizedBox(height: 2),
              Text(tab.label, style: TextStyle(fontSize: 10.5, fontWeight: selected ? FontWeight.w600 : FontWeight.w500, color: color)),
            ]),
          ),
        ),
      ),
    );
  }
}
