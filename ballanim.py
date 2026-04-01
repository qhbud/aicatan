"""
ballanim.py — Bob each AI ball based on actual audio amplitude.
Reads audio data via Blender's built-in aud module (no external deps).

Audio channel assignments:
  2 → ballgpt      3 → ballgemini    4 → ballgrok
  5 → balldeepseek 6 → ballclaude

Run with Alt+R in the Text Editor.
"""

import bpy
import aud
import math

BOB_HEIGHT       = 0.55  # max z rise at full (normalised) volume
VOLUME_THRESHOLD = 0.15  # normalised 0–1; frames below this keep the ball still
SAMPLE_EVERY     = 4     # process every Nth frame (higher = faster, choppier)

CHANNEL_TO_BALL = {
    2: "ballgpt",
    3: "ballgemini",
    4: "ballgrok",
    5: "balldeepseek",
    6: "ballclaude",
}

# ── helpers ───────────────────────────────────────────────────────────────────

def get_strips(seq_editor):
    for attr in ('strips_all', 'sequences_all', 'strips', 'sequences'):
        if hasattr(seq_editor, attr):
            return list(getattr(seq_editor, attr))
    return []


def rms_per_frame(filepath, sample_rate, channels, fps, n_frames):
    """
    Return a list of RMS values (0.0–1.0) for each frame, read via the aud module.
    Tries sound.data() (numpy-backed), then falls back to a manual reader loop.
    """
    import numpy as np

    # --- try: resample to fps so each sample = one frame, then read data ---
    try:
        buf = np.array(aud.Sound(filepath).rechannel(1).resample(int(fps), False).data()).flatten()
        print(f"[ballanim]   resample path: {len(buf)} samples, max={float(np.abs(buf).max()):.4f}")
        result = []
        for i in range(0, n_frames, SAMPLE_EVERY):
            chunk = buf[i: i + SAMPLE_EVERY]
            result.append(float(np.abs(chunk).mean()) if chunk.size else 0.0)
        return result
    except Exception as e:
        print(f"[ballanim]   resample path failed: {e}")

    # --- try: raw data() on original sound ---
    try:
        sound = aud.Sound(filepath)
        buf   = np.array(sound.data())
        print(f"[ballanim]   data() path: shape={buf.shape}, max={float(np.abs(buf).max()):.4f}")
        spf   = sample_rate / fps
        result = []
        for i in range(0, n_frames * SAMPLE_EVERY, SAMPLE_EVERY):
            s, e  = int(i * spf), int((i + SAMPLE_EVERY) * spf)
            chunk = buf[s:e]
            if chunk.size == 0:
                result.append(0.0)
                continue
            mono = chunk.mean(axis=1) if chunk.ndim > 1 else chunk
            result.append(float(np.sqrt(np.mean(mono ** 2))))
        return result
    except Exception as e:
        print(f"[ballanim]   data() path failed: {e}")

    # --- fallback: wave module (WAV only) ---
    import wave, struct
    if not filepath.lower().endswith('.wav'):
        print(f"[ballanim]   Cannot read '{filepath}' — MP3 and all aud paths failed")
        return [0.0] * (n_frames // SAMPLE_EVERY + 1)

    result = []
    sw  = 2        # assume 16-bit; wave module will tell us the real value
    fmt = 'h'
    mx  = 32768.0

    with wave.open(filepath, 'rb') as wf:
        ch  = wf.getnchannels()
        sw  = wf.getsampwidth()
        sr  = wf.getframerate()
        fmt = {1: 'b', 2: 'h', 4: 'i'}.get(sw, 'h')
        mx  = float(2 ** (8 * sw - 1))
        spf = sr / fps

        for i in range(0, n_frames, SAMPLE_EVERY):
            wf.setpos(int(i * spf))
            n   = max(1, int(spf * SAMPLE_EVERY))
            raw = wf.readframes(n)
            cnt = len(raw) // sw
            if cnt == 0:
                result.append(0.0)
                continue
            samp = struct.unpack(f'<{cnt}{fmt}', raw[:cnt * sw])
            if ch > 1:
                samp = [sum(samp[j::ch]) / ch for j in range(len(samp) // ch)]
            rms  = math.sqrt(sum(s * s for s in samp) / len(samp)) / mx
            result.append(rms)

    return result


def insert_z(obj, frame, z):
    obj.location.z = z
    obj.keyframe_insert("location", index=2, frame=frame)


HALO_SCALE  = 1.05   # outline sphere is 5% larger than the ball
HALO_SUFFIX = "_halo"


def create_halo(ball_obj):
    """
    Outline-only halo using a Backfacing shader:
      - Front faces → transparent   (hidden, so the ball shows through)
      - Back faces  → green emission (only visible at the silhouette edge)
    Result: a camera-facing green ring around the ball with no fill.
    Scale is keyframed 0 (hidden) ↔ HALO_SCALE (visible outline).
    """
    from mathutils import Matrix

    halo_name = ball_obj.name + HALO_SUFFIX
    old = bpy.data.objects.get(halo_name)
    if old:
        bpy.data.objects.remove(old, do_unlink=True)

    # Duplicate ball mesh so outline matches the ball's shape exactly
    bpy.ops.object.select_all(action='DESELECT')
    ball_obj.select_set(True)
    bpy.context.view_layer.objects.active = ball_obj
    bpy.ops.object.duplicate(linked=False)
    halo = bpy.context.active_object
    halo.name = halo_name

    # Parent: identity matrix_parent_inverse so halo inherits ball's full transform
    halo.parent = ball_obj
    halo.matrix_parent_inverse = Matrix.Identity(4)
    halo.location = (0.0, 0.0, 0.0)
    halo.scale    = (HALO_SCALE, HALO_SCALE, HALO_SCALE)

    # Build the backface-only green material
    mat = bpy.data.materials.new(name=halo_name + "_mat")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    geom        = nodes.new('ShaderNodeNewGeometry')
    transparent = nodes.new('ShaderNodeBsdfTransparent')
    emission    = nodes.new('ShaderNodeEmission')
    emission.inputs['Color'].default_value    = (0.0, 1.0, 0.0, 1.0)
    emission.inputs['Strength'].default_value = 3.0
    mix    = nodes.new('ShaderNodeMixShader')
    output = nodes.new('ShaderNodeOutputMaterial')

    # Backfacing = 0 → front face → transparent
    # Backfacing = 1 → back face  → green emission (visible at silhouette)
    links.new(geom.outputs['Backfacing'],   mix.inputs['Fac'])
    links.new(transparent.outputs['BSDF'],  mix.inputs[1])
    links.new(emission.outputs['Emission'], mix.inputs[2])
    links.new(mix.outputs['Shader'],        output.inputs['Surface'])

    # Enable transparency — try both old and new Blender API
    for attr, val in [('blend_method', 'BLEND'), ('surface_render_method', 'BLENDED')]:
        try:
            setattr(mat, attr, val)
            break
        except (AttributeError, TypeError):
            pass

    halo.data.materials.clear()
    halo.data.materials.append(mat)

    if halo.animation_data:
        halo.animation_data_clear()

    return halo


def insert_halo_scale(halo, frame, speaking):
    s = HALO_SCALE if speaking else 0.0
    halo.scale = (s, s, s)
    halo.keyframe_insert("scale", frame=frame)


# ── main ──────────────────────────────────────────────────────────────────────

scene      = bpy.context.scene
seq_editor = scene.sequence_editor
fps        = scene.render.fps

if seq_editor is None:
    print("[ballanim] No sequence editor found.")
else:
    all_strips = get_strips(seq_editor)

    # ── purge leftover halo / duplicate objects from previous runs ────────────
    ball_names = set(CHANNEL_TO_BALL.values())
    to_remove  = []
    for o in list(bpy.data.objects):
        if o.name in ball_names:
            continue
        # named by our current convention
        if HALO_SUFFIX in o.name:
            to_remove.append(o)
            continue
        # parented to a ball object (previous runs that didn't rename)
        if o.parent and o.parent.name in ball_names:
            to_remove.append(o)
    for o in to_remove:
        print(f"[ballanim] removing old object: {o.name}")
        bpy.data.objects.remove(o, do_unlink=True)

    for channel, ball_name in CHANNEL_TO_BALL.items():
        obj = bpy.data.objects.get(ball_name)
        if obj is None:
            print(f"[ballanim] '{ball_name}' not found — skipping channel {channel}")
            continue

        rest_z = obj.location.z

        halo = create_halo(obj)

        # Wipe the entire action so no old keyframes bleed through
        if obj.animation_data and obj.animation_data.action:
            old_action = obj.animation_data.action
            obj.animation_data.action = None
            bpy.data.actions.remove(old_action)

        sound_strips = sorted(
            [s for s in all_strips if s.channel == channel and s.type == 'SOUND'],
            key=lambda s: s.frame_start,
        )
        if not sound_strips:
            print(f"[ballanim] No sound strips on channel {channel} ({ball_name})")
            continue

        for strip in sound_strips:
            filepath = bpy.path.abspath(strip.sound.filepath)
            start    = int(strip.frame_start)
            end      = int(strip.frame_final_end)
            n_frames = end - start

            # Read audio specs
            try:
                snd      = aud.Sound(filepath)
                specs    = snd.specs          # (channels, sample_rate)
                s_rate   = specs[1]
                s_ch     = specs[0]
            except Exception as e:
                print(f"[ballanim] Could not open audio '{filepath}': {e}")
                continue

            volumes = rms_per_frame(filepath, s_rate, s_ch, fps, n_frames)

            peak = max(volumes) if volumes else 0.0
            print(f"[ballanim]   {ball_name} strip frames {start}–{end}: "
                  f"{len(volumes)} samples, peak RMS={peak:.4f}, filepath={filepath}")

            # Normalise so the loudest moment = 1.0
            if peak > 0:
                volumes = [v / peak for v in volumes]

            # Pin at rest one frame before the strip
            insert_z(obj, max(1, start - 1), rest_z)
            insert_halo_scale(halo, max(1, start - 1), False)

            prev_z        = rest_z
            prev_speaking = False

            for idx, vol in enumerate(volumes):
                frame    = start + idx * SAMPLE_EVERY
                speaking = vol >= VOLUME_THRESHOLD
                target_z = rest_z + vol * BOB_HEIGHT if speaking else rest_z

                z_changed = abs(target_z - prev_z) > 0.005
                s_changed = speaking != prev_speaking

                if z_changed or s_changed or idx == 0 or idx == len(volumes) - 1:
                    insert_z(obj, frame, target_z)
                    if s_changed or idx == 0 or idx == len(volumes) - 1:
                        insert_halo_scale(halo, frame, speaking)
                    prev_z        = target_z
                    prev_speaking = speaking

            # Pin at rest after the strip
            insert_z(obj, end + 1, rest_z)
            insert_halo_scale(halo, end + 1, False)

        # Apply SINE easing on the z f-curve
        if obj.animation_data and obj.animation_data.action:
            action = obj.animation_data.action
            fcurves = []
            if hasattr(action, 'fcurves'):
                fcurves = action.fcurves
            else:
                for layer in action.layers:
                    for astrip in layer.strips:
                        if hasattr(astrip, 'channelbags'):
                            for bag in astrip.channelbags:
                                fcurves.extend(bag.fcurves)
            for fc in fcurves:
                if fc.data_path == 'location' and fc.array_index == 2:
                    for kp in fc.keyframe_points:
                        kp.interpolation = 'SINE'
                        kp.easing = 'EASE_IN_OUT'

        print(f"[ballanim] {ball_name}: done ({len(sound_strips)} strip(s))")

    print("[ballanim] Done.")
