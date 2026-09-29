import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';

import '../api/chat.dart';
import '../app_scope.dart';
import '../theme.dart';

/// Money rain when a trade hits its take profit (the trader: "add animation in the app for money
/// when it hits TP"). Wraps the whole app, listens to the bot's live feed for a trade that closed
/// at its TP, and plays a few seconds of falling money with the profit on a banner. It never takes
/// a tap -- the app works normally underneath.
class MoneyRain extends StatefulWidget {
  const MoneyRain({super.key, required this.child, this.listen = true});
  final Widget child;

  /// Off in tests that drive [MoneyRainState.celebrate] themselves.
  final bool listen;

  static MoneyRainState? of(BuildContext context) => context.findAncestorStateOfType<MoneyRainState>();

  @override
  State<MoneyRain> createState() => MoneyRainState();
}

class _Bill {
  _Bill(math.Random r)
      : x = r.nextDouble(),
        delay = r.nextDouble() * 0.35,
        speed = 0.75 + r.nextDouble() * 0.6,
        size = 24 + r.nextDouble() * 22,
        spin = (r.nextDouble() - 0.5) * 6,
        sway = 12 + r.nextDouble() * 26,
        emoji = _emojis[r.nextInt(_emojis.length)];
  static const _emojis = ['💵', '💵', '💰', '🤑', '💸', '💵'];
  final double x, delay, speed, size, spin, sway;
  final String emoji;
}

class MoneyRainState extends State<MoneyRain> with SingleTickerProviderStateMixin {
  late final AnimationController _anim = AnimationController(vsync: this, duration: const Duration(milliseconds: 3400));
  List<_Bill> _bills = const [];
  String _amount = '';
  String _label = '';
  ActivityStream? _stream;
  StreamSubscription<ActivityEvent>? _sub;
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started || !widget.listen) return;
    _started = true;
    unawaited(_connect());
  }

  Future<void> _connect() async {
    try {
      final api = ChatApi.of(AppScope.of(context).api);
      // Only what happens from now on -- never replay old wins when the app opens.
      final latest = (await api.activity(after: 1 << 30, feeds: const ['background'])).latestEventId;
      if (!mounted) return;
      final stream = api.stream(after: latest, feeds: const ['background']);
      _stream = stream;
      _sub = stream.events.listen((e) {
        if (e.kind == 'trade_closed' && e.data['reason'] == 'tp') {
          celebrate(pnl: (e.data['pnl'] as num?)?.toDouble(), symbol: e.data['symbol'] as String?);
        }
      }, onError: (_) {});
      stream.start();
    } catch (_) {
      // No feed, no party -- the app itself is unaffected.
    }
  }

  /// Plays the rain. Public so a test (or a future "you hit TP" push) can trigger it.
  void celebrate({double? pnl, String? symbol}) {
    final r = math.Random();
    setState(() {
      _bills = List.generate(34, (_) => _Bill(r));
      _amount = pnl == null ? 'TP HIT' : '${pnl >= 0 ? '+' : '-'}\$${pnl.abs().toStringAsFixed(2)}';
      _label = symbol == null ? 'Take profit hit' : '$symbol hit take profit';
    });
    HapticFeedback.heavyImpact();
    _anim.forward(from: 0);
  }

  @override
  void dispose() {
    _sub?.cancel();
    _stream?.close();
    _anim.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(children: [
      widget.child,
      Positioned.fill(
        child: IgnorePointer(
          child: AnimatedBuilder(
            animation: _anim,
            builder: (context, _) {
              if (!_anim.isAnimating) return const SizedBox.shrink();
              final t = _anim.value;
              return LayoutBuilder(builder: (context, box) {
                final h = box.maxHeight;
                final w = box.maxWidth;
                // Banner: pops in, holds, fades out at the end.
                final pop = Curves.elasticOut.transform((t / 0.35).clamp(0.0, 1.0));
                final fade = t < 0.8 ? 1.0 : (1 - (t - 0.8) / 0.2).clamp(0.0, 1.0);
                return Stack(children: [
                  for (final b in _bills)
                    if (t > b.delay)
                      Builder(builder: (_) {
                        final p = ((t - b.delay) * b.speed * 1.35).clamp(0.0, 1.2);
                        final y = -60 + p * (h + 120);
                        final x = b.x * w + math.sin(p * math.pi * 3) * b.sway;
                        return Positioned(
                          left: x - b.size / 2,
                          top: y,
                          child: Opacity(
                            opacity: fade,
                            child: Transform.rotate(angle: p * b.spin, child: Text(b.emoji, style: TextStyle(fontSize: b.size))),
                          ),
                        );
                      }),
                  Center(
                    child: Opacity(
                      opacity: fade,
                      child: Transform.scale(
                        scale: 0.4 + 0.6 * pop,
                        child: Container(
                          key: const ValueKey('money-rain-banner'),
                          padding: const EdgeInsets.symmetric(horizontal: 26, vertical: 18),
                          decoration: BoxDecoration(
                            color: resolve(context, CupertinoColors.systemGreen).withValues(alpha: 0.94),
                            borderRadius: BorderRadius.circular(26),
                            boxShadow: [BoxShadow(color: const Color(0xFF34C759).withValues(alpha: 0.5), blurRadius: 30)],
                          ),
                          child: Column(mainAxisSize: MainAxisSize.min, children: [
                            const Text('🤑', style: TextStyle(fontSize: 46)),
                            const SizedBox(height: 4),
                            Text(_amount, style: const TextStyle(fontSize: 34, fontWeight: FontWeight.w800, color: Color(0xFFFFFFFF), fontFeatures: [FontFeature.tabularFigures()])),
                            const SizedBox(height: 2),
                            Text(_label, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: Color(0xFFFFFFFF))),
                          ]),
                        ),
                      ),
                    ),
                  ),
                ]);
              });
            },
          ),
        ),
      ),
    ]);
  }
}
