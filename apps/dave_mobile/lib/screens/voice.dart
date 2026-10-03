import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/chat.dart';
import '../api/gemini_live.dart';
import '../look.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// Talk to Dave (Gemini Live): speak, interrupt, watch him think and reach for his tools while he
/// answers out loud.
///
/// The screen is driven entirely by a [VoiceSession] snapshot, so the same widgets render a live
/// call ([LiveCallPage], fed by [LiveCall]) and the design states used in tests.
///
///   ┌ header ─ model · voice · timer ring (15 min session) ┐
///   │ tool rail  ─ live chips: running / done / waiting     │
///   │ the orb    ─ listening · thinking · speaking · tools  │
///   │ transcript ─ you (partial) / Dave (spoken so far)     │
///   │ confirm    ─ "say yes or tap" before any trade action │
///   └ controls   ─ mute · chart · end · keyboard            ┘

enum VoicePhase { connecting, listening, thinking, tools, speaking, confirm }

enum ToolRun { running, done, failed }

class VoiceTool {
  const VoiceTool({
    required this.icon,
    required this.label,
    required this.state,
    this.result,
    this.ms,
  });
  final IconData icon;
  final String label;
  final ToolRun state;
  final String? result;
  final int? ms;
}

class VoiceLine {
  const VoiceLine({required this.me, required this.text, this.partial = false});
  final bool me;
  final String text;
  final bool partial;
}

class VoiceConfirm {
  const VoiceConfirm({
    required this.title,
    required this.detail,
    required this.risk,
  });
  final String title;
  final String detail;
  final String risk;
}

class VoiceSession {
  const VoiceSession({
    required this.phase,
    this.model = 'Gemini Live',
    this.voice = 'Kore',
    this.thinkingLevel,
    this.elapsed = Duration.zero,
    this.limit = const Duration(minutes: 15),
    this.level = 0.5,
    this.tools = const [],
    this.lines = const [],
    this.thoughts = const [],
    this.confirm,
    this.muted = false,
    this.chartShared = false,
  });

  final VoicePhase phase;
  final String model;
  final String voice;

  /// low / medium / high on the extended-thinking model; null on the fast one.
  final String? thinkingLevel;
  final Duration elapsed;
  final Duration limit;

  /// 0..1 loudness of whoever is talking -- drives the orb.
  final double level;
  final List<VoiceTool> tools;
  final List<VoiceLine> lines;

  /// Short thought summaries streamed while thinking.
  final List<String> thoughts;
  final VoiceConfirm? confirm;
  final bool muted;
  final bool chartShared;
}

class VoiceScreen extends StatefulWidget {
  const VoiceScreen({
    super.key,
    required this.session,
    this.onEnd,
    this.onMute,
    this.onChart,
    this.onKeyboard,
    this.onConfirm,
    this.onSettings,
  });
  final VoiceSession session;
  final VoidCallback? onEnd;
  final VoidCallback? onMute;
  final VoidCallback? onChart;
  final VoidCallback? onKeyboard;
  final void Function(bool yes)? onConfirm;
  final VoidCallback? onSettings;

  @override
  State<VoiceScreen> createState() => _VoiceScreenState();
}

class _VoiceScreenState extends State<VoiceScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _t = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 6),
  )..repeat();

  @override
  void dispose() {
    _t.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.session;
    final look = Look.of(context);
    final pad = MediaQuery.paddingOf(context);
    return CupertinoPageScaffold(
      backgroundColor: const Color(0x00000000),
      child: Stack(
        children: [
          // A darker veil over the aurora: a call is a focused place.
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: look.base.withValues(alpha: look.dark ? 0.55 : 0.35),
              ),
            ),
          ),
          Padding(
            padding: EdgeInsets.fromLTRB(
              Space.s4,
              pad.top + Space.s2,
              Space.s4,
              pad.bottom + Space.s3,
            ),
            child: Column(
              children: [
                _Header(s: s, onSettings: widget.onSettings),
                const SizedBox(height: Space.s3),
                _ToolRail(tools: s.tools),
                Expanded(
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    child: SizedBox(
                      width: MediaQuery.sizeOf(context).width - Space.s4 * 2,
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          AnimatedBuilder(
                            animation: _t,
                            // Room for the thoughts / a full tool rail: the orb steps back.
                            builder: (context, _) => _Orb(
                              phase: s.phase,
                              level: s.level,
                              t: _t.value,
                              size:
                                  (s.phase == VoicePhase.thinking &&
                                          s.thoughts.isNotEmpty) ||
                                      s.tools.length > 2 ||
                                      s.confirm != null
                                  ? 150
                                  : 230,
                            ),
                          ),
                          const SizedBox(height: Space.s4),
                          _PhaseLabel(s: s),
                          if (s.phase == VoicePhase.thinking &&
                              s.thoughts.isNotEmpty) ...[
                            const SizedBox(height: Space.s3),
                            _Thoughts(thoughts: s.thoughts),
                          ],
                        ],
                      ),
                    ),
                  ),
                ),
                if (s.confirm != null)
                  _ConfirmCard(c: s.confirm!, onConfirm: widget.onConfirm)
                else
                  _Transcript(lines: s.lines),
                const SizedBox(height: Space.s4),
                _Controls(
                  s: s,
                  onEnd: widget.onEnd,
                  onMute: widget.onMute,
                  onChart: widget.onChart,
                  onKeyboard: widget.onKeyboard,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ───────────────────────────── header ─────────────────────────────

class _Header extends StatelessWidget {
  const _Header({required this.s, this.onSettings});
  final VoiceSession s;
  final VoidCallback? onSettings;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final left = s.limit - s.elapsed;
    String mmss(Duration d) =>
        '${d.inMinutes.toString().padLeft(2, '0')}:${(d.inSeconds % 60).toString().padLeft(2, '0')}';
    return Row(
      children: [
        Container(
          width: 38,
          height: 38,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: look.hero,
          ),
          alignment: Alignment.center,
          child: Text(
            'D',
            style: TextStyle(fontWeight: FontWeight.w900, color: look.heroText),
          ),
        ),
        const SizedBox(width: Space.s3),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Dave',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
              ),
              Text(
                '${s.model}${s.thinkingLevel != null ? ' · thinking ${s.thinkingLevel}' : ''} · voice ${s.voice}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12, color: secondary),
              ),
            ],
          ),
        ),
        // Call clock: a ring that fills over half an hour (the call resumes by itself when Google
        // closes the socket, so it's a guide, not a limit).
        SizedBox(
          width: 54,
          height: 54,
          child: Stack(
            alignment: Alignment.center,
            children: [
              CustomPaint(
                size: const Size(54, 54),
                painter: _RingPainter(
                  fraction:
                      s.elapsed.inSeconds / math.max(1, s.limit.inSeconds),
                  color: left.inMinutes < 2 ? look.down : look.accent,
                  track: look.line,
                ),
              ),
              Text(
                mmss(s.elapsed),
                style: const TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  fontFeatures: [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
        ),
        CupertinoButton(
          padding: const EdgeInsets.only(left: 6),
          minimumSize: const Size(34, 34),
          onPressed: onSettings,
          child: Icon(CupertinoIcons.slider_horizontal_3, color: secondary),
        ),
      ],
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter({
    required this.fraction,
    required this.color,
    required this.track,
  });
  final double fraction;
  final Color color;
  final Color track;

  @override
  void paint(Canvas canvas, Size size) {
    final r = Rect.fromLTWH(3, 3, size.width - 6, size.height - 6);
    canvas.drawArc(
      r,
      0,
      math.pi * 2,
      false,
      Paint()
        ..color = track
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3,
    );
    canvas.drawArc(
      r,
      -math.pi / 2,
      math.pi * 2 * fraction.clamp(0, 1),
      false,
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round
        ..strokeWidth = 3,
    );
  }

  @override
  bool shouldRepaint(covariant _RingPainter old) =>
      old.fraction != fraction || old.color != color;
}

// ───────────────────────────── live tool calls ─────────────────────────────

class _ToolRail extends StatelessWidget {
  const _ToolRail({required this.tools});
  final List<VoiceTool> tools;

  @override
  Widget build(BuildContext context) {
    if (tools.isEmpty) return const SizedBox(height: 40);
    return Column(
      children: [
        for (final t in tools.take(4))
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: _ToolChip(t: t),
          ),
      ],
    );
  }
}

class _ToolChip extends StatelessWidget {
  const _ToolChip({required this.t});
  final VoiceTool t;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final color = switch (t.state) {
      ToolRun.running => look.accent,
      ToolRun.done => look.up,
      ToolRun.failed => look.down,
    };
    return AnimatedContainer(
      duration: const Duration(milliseconds: 250),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: look.card.withValues(alpha: 0.85),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: t.state == ToolRun.running
              ? look.accent.withValues(alpha: 0.7)
              : look.line,
        ),
      ),
      child: Row(
        children: [
          Icon(t.icon, size: 16, color: color),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              t.label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 13.5,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          if (t.result != null) ...[
            Flexible(
              child: Text(
                t.result!,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 12.5,
                  color: secondary,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ),
            const SizedBox(width: 8),
          ],
          switch (t.state) {
            ToolRun.running => const CupertinoActivityIndicator(radius: 7),
            ToolRun.done => Icon(
              CupertinoIcons.checkmark_circle_fill,
              size: 17,
              color: look.up,
            ),
            ToolRun.failed => Icon(
              CupertinoIcons.exclamationmark_circle_fill,
              size: 17,
              color: look.down,
            ),
          },
          if (t.ms != null)
            Padding(
              padding: const EdgeInsets.only(left: 6),
              child: Text(
                '${(t.ms! / 1000).toStringAsFixed(1)}s',
                style: TextStyle(fontSize: 11, color: secondary),
              ),
            ),
        ],
      ),
    );
  }
}

// ───────────────────────────── the orb ─────────────────────────────

class _Orb extends StatelessWidget {
  const _Orb({
    required this.phase,
    required this.level,
    required this.t,
    this.size = 230,
  });
  final double size;
  final VoicePhase phase;
  final double level;
  final double t;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final color = switch (phase) {
      VoicePhase.listening => look.accent,
      VoicePhase.speaking => look.accent2,
      VoicePhase.thinking => resolve(context, CupertinoColors.systemPurple),
      VoicePhase.tools => look.accent,
      VoicePhase.confirm => resolve(context, CupertinoColors.systemOrange),
      VoicePhase.connecting => look.line,
    };
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(
        painter: _OrbPainter(
          phase: phase,
          level: level,
          t: t,
          color: color,
          core: look.card,
        ),
      ),
    );
  }
}

class _OrbPainter extends CustomPainter {
  _OrbPainter({
    required this.phase,
    required this.level,
    required this.t,
    required this.color,
    required this.core,
  });
  final VoicePhase phase;
  final double level;
  final double t;
  final Color color;
  final Color core;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final base = size.width * 0.28;
    // Soft glow.
    canvas.drawCircle(
      c,
      base * 1.6,
      Paint()
        ..shader = RadialGradient(
          colors: [color.withValues(alpha: 0.35), color.withValues(alpha: 0)],
        ).createShader(Rect.fromCircle(center: c, radius: base * 1.6)),
    );
    final tau = math.pi * 2;
    if (phase == VoicePhase.listening || phase == VoicePhase.speaking) {
      // A living blob: its edge wobbles with the voice level.
      for (var ring = 0; ring < 3; ring++) {
        final path = Path();
        for (var i = 0; i <= 72; i++) {
          final a = i / 72 * tau;
          final wobble =
              math.sin(a * (3 + ring) + t * tau * (ring.isEven ? 1 : -1)) *
                  0.5 +
              math.sin(a * 5 - t * tau * 2) * 0.5;
          final r =
              base * (1 + 0.06 * ring) + wobble * base * 0.12 * (0.3 + level);
          final p = c + Offset(math.cos(a) * r, math.sin(a) * r);
          i == 0 ? path.moveTo(p.dx, p.dy) : path.lineTo(p.dx, p.dy);
        }
        canvas.drawPath(
          path,
          Paint()
            ..color = color.withValues(
              alpha: ring == 0 ? 0.9 : 0.35 - ring * 0.08,
            )
            ..style = ring == 0 ? PaintingStyle.fill : PaintingStyle.stroke
            ..strokeWidth = 2,
        );
      }
      // Bars inside: whose voice it is -- short and even when listening, tall when Dave speaks.
      final bars = 7;
      for (var i = 0; i < bars; i++) {
        final x = c.dx + (i - (bars - 1) / 2) * base * 0.2;
        final h =
            base *
            (0.18 +
                0.55 *
                    level *
                    (0.5 + 0.5 * math.sin(t * tau * 3 + i * 1.3)).abs());
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            Rect.fromCenter(
              center: Offset(x, c.dy),
              width: base * 0.1,
              height: h,
            ),
            Radius.circular(base * 0.05),
          ),
          Paint()..color = core,
        );
      }
    } else if (phase == VoicePhase.thinking) {
      // Orbiting dots: a mind at work, no voice.
      canvas.drawCircle(
        c,
        base * 0.9,
        Paint()..color = color.withValues(alpha: 0.85),
      );
      for (var i = 0; i < 3; i++) {
        final a = t * tau * (1 + i * 0.35) + i * tau / 3;
        final r = base * (1.18 + i * 0.12);
        canvas.drawCircle(
          c + Offset(math.cos(a) * r, math.sin(a) * r),
          base * 0.07,
          Paint()..color = color,
        );
      }
      canvas.drawCircle(
        c,
        base * 0.9,
        Paint()
          ..color = core.withValues(alpha: 0.35)
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2,
      );
    } else if (phase == VoicePhase.tools) {
      // Spinning segments: reaching out to MT5 / the brain.
      canvas.drawCircle(
        c,
        base * 0.85,
        Paint()..color = color.withValues(alpha: 0.9),
      );
      for (var i = 0; i < 4; i++) {
        final start = t * tau * 1.5 + i * tau / 4;
        canvas.drawArc(
          Rect.fromCircle(center: c, radius: base * 1.15),
          start,
          tau / 8,
          false,
          Paint()
            ..color = color
            ..style = PaintingStyle.stroke
            ..strokeCap = StrokeCap.round
            ..strokeWidth = 5,
        );
      }
    } else {
      canvas.drawCircle(
        c,
        base * (0.9 + 0.04 * math.sin(t * tau * 2)),
        Paint()..color = color.withValues(alpha: 0.85),
      );
    }
  }

  @override
  bool shouldRepaint(covariant _OrbPainter old) => true;
}

class _PhaseLabel extends StatelessWidget {
  const _PhaseLabel({required this.s});
  final VoiceSession s;

  @override
  Widget build(BuildContext context) {
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final running = s.tools.where((t) => t.state == ToolRun.running).length;
    final (title, sub) = switch (s.phase) {
      VoicePhase.connecting => ('Connecting…', 'Opening a live line to Dave'),
      VoicePhase.listening => (
        s.muted ? 'Muted' : 'Listening',
        s.muted
            ? 'Tap the mic to talk'
            : 'Talk any time -- interrupt him whenever',
      ),
      VoicePhase.thinking => (
        'Thinking',
        s.thinkingLevel == null
            ? 'Working it out'
            : 'Extended thinking · ${s.thinkingLevel}',
      ),
      VoicePhase.tools => (
        'Checking $running thing${running == 1 ? '' : 's'} at once',
        'He keeps talking while they run',
      ),
      VoicePhase.speaking => (
        'Dave is speaking',
        'Just start talking to cut in',
      ),
      VoicePhase.confirm => (
        'Needs your yes',
        'Say "yes" or tap -- nothing moves until you do',
      ),
    };
    return Column(
      children: [
        Text(
          title,
          style: const TextStyle(
            fontSize: 22,
            fontWeight: FontWeight.w800,
            letterSpacing: -0.5,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          sub,
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 13.5, color: secondary),
        ),
      ],
    );
  }
}

class _Thoughts extends StatelessWidget {
  const _Thoughts({required this.thoughts});
  final List<String> thoughts;

  @override
  Widget build(BuildContext context) {
    final purple = resolve(context, CupertinoColors.systemPurple);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    return Container(
      padding: const EdgeInsets.all(Space.s3),
      decoration: BoxDecoration(
        color: purple.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: purple.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var i = 0; i < thoughts.length; i++)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(top: 5),
                    child: Container(
                      width: 6,
                      height: 6,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: i == thoughts.length - 1
                            ? purple
                            : purple.withValues(alpha: 0.4),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      thoughts[i],
                      style: TextStyle(
                        fontSize: 13,
                        height: 1.35,
                        color: i == thoughts.length - 1 ? null : secondary,
                        fontStyle: FontStyle.italic,
                      ),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

// ───────────────────────────── transcript + confirm ─────────────────────────────

class _Transcript extends StatelessWidget {
  const _Transcript({required this.lines});
  final List<VoiceLine> lines;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    final shown = lines.length > 3 ? lines.sublist(lines.length - 3) : lines;
    return Container(
      width: double.infinity,
      constraints: const BoxConstraints(minHeight: 96),
      padding: const EdgeInsets.all(Space.s3),
      decoration: glassDecoration(context, radius: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var i = 0; i < shown.length; i++)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Opacity(
                opacity: i == shown.length - 1 ? 1 : 0.55,
                child: RichText(
                  text: TextSpan(
                    style: DefaultTextStyle.of(context).style
                        .copyWith(fontSize: 15, height: 1.35),
                    children: [
                      TextSpan(
                        text: shown[i].me ? 'You  ' : 'Dave  ',
                        style: TextStyle(
                          fontWeight: FontWeight.w800,
                          fontSize: 12,
                          color: shown[i].me ? secondary : look.accent,
                        ),
                      ),
                      TextSpan(text: shown[i].text),
                      if (shown[i].partial)
                        TextSpan(
                          text: ' ▍',
                          style: TextStyle(color: look.accent),
                        ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _ConfirmCard extends StatelessWidget {
  const _ConfirmCard({required this.c, this.onConfirm});
  final VoiceConfirm c;
  final void Function(bool yes)? onConfirm;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final orange = resolve(context, CupertinoColors.systemOrange);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    return Container(
      padding: const EdgeInsets.all(Space.s4),
      decoration: BoxDecoration(
        color: look.card,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: orange.withValues(alpha: 0.7), width: 1.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(CupertinoIcons.hand_raised_fill, color: orange, size: 18),
              const SizedBox(width: 6),
              Text(
                'TRADE ACTION',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.2,
                  color: orange,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            c.title,
            style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 2),
          Text(c.detail, style: TextStyle(fontSize: 13.5, color: secondary)),
          const SizedBox(height: 4),
          Text(c.risk, style: TextStyle(fontSize: 12.5, color: secondary)),
          const SizedBox(height: Space.s3),
          Row(
            children: [
              Expanded(
                child: GestureDetector(
                  onTap: () {
                    HapticFeedback.lightImpact();
                    onConfirm?.call(false);
                  },
                  child: Container(
                    height: 48,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: look.chip,
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: const Text(
                      'No',
                      style: TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 16,
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: Space.s2),
              Expanded(
                flex: 2,
                child: GestureDetector(
                  key: const ValueKey('voice-confirm-yes'),
                  onTap: () {
                    HapticFeedback.mediumImpact();
                    onConfirm?.call(true);
                  },
                  child: Container(
                    height: 48,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: look.accent,
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Text(
                      'Yes, do it',
                      style: TextStyle(
                        fontWeight: FontWeight.w800,
                        fontSize: 16,
                        color: look.tabActiveIcon,
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// ───────────────────────────── controls ─────────────────────────────

class _Controls extends StatelessWidget {
  const _Controls({
    required this.s,
    this.onEnd,
    this.onMute,
    this.onChart,
    this.onKeyboard,
  });
  final VoiceSession s;
  final VoidCallback? onEnd;
  final VoidCallback? onMute;
  final VoidCallback? onChart;
  final VoidCallback? onKeyboard;

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    Widget round(
      IconData icon,
      String label,
      VoidCallback? onTap, {
      Color? bg,
      Color? fg,
      bool on = false,
      double size = 58,
    }) => Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        GestureDetector(
          onTap: onTap,
          child: Container(
            width: size,
            height: size,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: bg ?? (on ? look.accent : look.card),
              border: Border.all(color: look.line),
            ),
            child: Icon(
              icon,
              color: fg ?? (on ? look.tabActiveIcon : null),
              size: size * 0.42,
            ),
          ),
        ),
        const SizedBox(height: 5),
        Text(
          label,
          style: TextStyle(
            fontSize: 11.5,
            color: resolve(context, CupertinoColors.secondaryLabel),
          ),
        ),
      ],
    );
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        round(
          s.muted ? CupertinoIcons.mic_slash_fill : CupertinoIcons.mic_fill,
          s.muted ? 'Unmute' : 'Mute',
          onMute,
          on: s.muted,
        ),
        if (onChart != null)
          round(
            CupertinoIcons.chart_bar_square_fill,
            s.chartShared ? 'Sharing' : 'Show chart',
            onChart,
            on: s.chartShared,
          ),
        round(
          CupertinoIcons.phone_down_fill,
          'End',
          onEnd,
          bg: look.down,
          fg: const Color(0xFFFFFFFF),
          size: 70,
        ),
        round(CupertinoIcons.keyboard, 'Type', onKeyboard),
      ],
    );
  }
}

// ───────────────────────────── settings ─────────────────────────────

/// What a call starts with: the Live model, Dave's voice, and whether he may act on trades.
class LiveOptions {
  const LiveOptions({
    this.thinking = false,
    this.voice = 'Charon',
    this.allowActions = true,
  });
  final bool thinking;
  final String voice;
  final bool allowActions;

  static const voices = [
    'Charon',
    'Puck',
    'Kore',
    'Fenrir',
    'Aoede',
    'Orus',
    'Leda',
    'Zephyr',
  ];
  static final _prefs = SharedPreferencesAsync();

  static Future<LiveOptions> load() async {
    try {
      final v = await _prefs.getString('live.voice');
      return LiveOptions(
        thinking: await _prefs.getBool('live.thinking') ?? false,
        voice: voices.contains(v) ? v! : 'Charon',
        allowActions: await _prefs.getBool('live.actions') ?? true,
      );
    } catch (_) {
      return const LiveOptions();
    }
  }

  Future<void> save() async {
    try {
      await _prefs.setBool('live.thinking', thinking);
      await _prefs.setString('live.voice', voice);
      await _prefs.setBool('live.actions', allowActions);
    } catch (_) {}
  }
}

/// Before/while talking: which Live model, his voice, and whether he may act. Changes apply from
/// the next call.
class VoiceSettingsSheet extends StatefulWidget {
  const VoiceSettingsSheet({
    super.key,
    this.options = const LiveOptions(),
    this.onChanged,
  });
  final LiveOptions options;
  final void Function(LiveOptions)? onChanged;

  @override
  State<VoiceSettingsSheet> createState() => _VoiceSettingsSheetState();
}

class _VoiceSettingsSheetState extends State<VoiceSettingsSheet> {
  late LiveOptions _o = widget.options;

  @override
  void didUpdateWidget(VoiceSettingsSheet old) {
    super.didUpdateWidget(old);
    if (old.options != widget.options) _o = widget.options;
  }

  void _set(LiveOptions o) {
    setState(() => _o = o);
    unawaited(o.save());
    widget.onChanged?.call(o);
  }

  @override
  Widget build(BuildContext context) {
    final look = Look.of(context);
    final secondary = resolve(context, CupertinoColors.secondaryLabel);
    Widget seg(List<String> items, String value, void Function(String) on) =>
        Container(
          padding: const EdgeInsets.all(3),
          decoration: BoxDecoration(
            color: look.chip,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Row(
            children: [
              for (final i in items)
                Expanded(
                  child: GestureDetector(
                    onTap: () => on(i),
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 150),
                      padding: const EdgeInsets.symmetric(vertical: 9),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: i == value ? look.accent : null,
                        borderRadius: BorderRadius.circular(9),
                      ),
                      child: Text(
                        i,
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                          color: i == value ? look.tabActiveIcon : null,
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        );
    Widget label(String t) => Text(
      t,
      style: TextStyle(
        fontSize: 11,
        fontWeight: FontWeight.w800,
        letterSpacing: 1,
        color: secondary,
      ),
    );
    LiveOptions with_({bool? thinking, String? voice, bool? allowActions}) =>
        LiveOptions(
          thinking: thinking ?? _o.thinking,
          voice: voice ?? _o.voice,
          allowActions: allowActions ?? _o.allowActions,
        );
    return Container(
      padding: EdgeInsets.fromLTRB(
        Space.s4,
        Space.s4,
        Space.s4,
        Space.s4 + MediaQuery.paddingOf(context).bottom,
      ),
      decoration: BoxDecoration(
        color: look.card,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Voice call',
            style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 2),
          Text(
            'Changes apply from your next call.',
            style: TextStyle(fontSize: 12.5, color: secondary),
          ),
          const SizedBox(height: Space.s3),
          label('BRAIN'),
          const SizedBox(height: 6),
          seg(
            ['Fast', 'Deep thinking'],
            _o.thinking ? 'Deep thinking' : 'Fast',
            (v) => _set(with_(thinking: v == 'Deep thinking')),
          ),
          const SizedBox(height: 6),
          Text(
            _o.thinking
                ? 'Thinks before he answers -- better for tricky questions, a beat slower.'
                : 'Answers instantly -- best for quick checks and moving trades.',
            style: TextStyle(fontSize: 12, color: secondary),
          ),
          const SizedBox(height: Space.s3),
          label('HIS VOICE'),
          const SizedBox(height: 6),
          seg(
            LiveOptions.voices.sublist(0, 4),
            _o.voice,
            (v) => _set(with_(voice: v)),
          ),
          const SizedBox(height: 6),
          seg(
            LiveOptions.voices.sublist(4),
            _o.voice,
            (v) => _set(with_(voice: v)),
          ),
          const SizedBox(height: Space.s3),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Let him act on trades',
                        style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      Text(
                        'Breakeven, SL/TP, close, new trades -- always asks "yes?" first',
                        style: TextStyle(fontSize: 12, color: secondary),
                      ),
                    ],
                  ),
                ),
                CupertinoSwitch(
                  value: _o.allowActions,
                  activeTrackColor: look.accent,
                  onChanged: (x) => _set(with_(allowActions: x)),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ───────────────────────────── the call ─────────────────────────────

/// A real call: opens the line (bot -> one-use token -> Google), drives [VoiceScreen] from it, and
/// saves the transcript into the chat when it ends.
class LiveCallPage extends StatefulWidget {
  const LiveCallPage({super.key, required this.api, required this.options, this.callId});
  final ChatApi api;
  final LiveOptions options;
  /// Set when this is a call Dave placed and the trader answered: he opens it himself.
  final String? callId;

  static Future<void> open(BuildContext context, ChatApi api, {String? callId}) async {
    final options = await LiveOptions.load();
    if (!context.mounted) return;
    await Navigator.of(context, rootNavigator: true).push(
      CupertinoPageRoute<void>(
        fullscreenDialog: true,
        builder: (_) => LiveCallPage(api: api, options: options, callId: callId),
      ),
    );
  }

  @override
  State<LiveCallPage> createState() => _LiveCallPageState();
}

class _LiveCallPageState extends State<LiveCallPage> {
  late LiveOptions _options = widget.options;
  late final LiveCall _call = LiveCall(
    start: () => widget.api.liveStart(
      thinking: _options.thinking,
      voice: _options.voice,
      allowActions: _options.allowActions,
      callId: widget.callId,
    ),
    runTool: widget.api.liveTool,
    onEnd: widget.api.liveEnd,
  )..voiceName = widget.options.voice;
  bool _closing = false;

  @override
  void initState() {
    super.initState();
    _call.addListener(_changed);
    // Dave called: once the line is open, he speaks first (his reason is in his instructions).
    if (widget.callId != null) _call.onReady = () => _call.sendText('(I picked up your call. Go ahead -- tell me why you called.)', show: false);
    unawaited(_call.begin());
  }

  void _changed() {
    if (!mounted) return;
    setState(() {});
    if (_call.ended && !_closing) {
      _closing = true;
      final error = _call.error;
      if (error != null) {
        unawaited(
          showError(context, error).then((_) {
            if (mounted) Navigator.of(context).pop();
          }),
        );
      } else {
        Navigator.of(context).pop();
      }
    }
  }

  @override
  void dispose() {
    _call.removeListener(_changed);
    _call.dispose();
    super.dispose();
  }

  Future<void> _type() async {
    final text = await promptText(
      context,
      title: 'Type to Dave',
      placeholder: 'e.g. move gold to breakeven',
      action: 'Send',
    );
    if (text != null && text.isNotEmpty) _call.sendText(text);
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        const Positioned.fill(child: Aurora()),
        VoiceScreen(
          session: _call.session,
          onEnd: () {
            HapticFeedback.mediumImpact();
            unawaited(_call.hangUp());
          },
          onMute: () {
            HapticFeedback.selectionClick();
            _call.toggleMute();
          },
          onKeyboard: _type,
          onConfirm: _call.answerConfirm,
          onSettings: () => showCupertinoModalPopup<void>(
            context: context,
            builder: (_) => VoiceSettingsSheet(
              options: _options,
              onChanged: (o) => _options = o,
            ),
          ),
        ),
      ],
    );
  }
}
