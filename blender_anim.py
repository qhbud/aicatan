"""
Catan AI – Turn-by-turn resource animation for Blender.
Run from Blender's Text Editor (Alt+R or the Run Script button).
"""

import bpy
import math
from mathutils import Vector, Euler

# ══════════════════════════════════════════════════════════════════════════════
# CONSTANTS
# ══════════════════════════════════════════════════════════════════════════════
PLAYERS       = ["gpt4o", "gemini", "grok", "deepseek", "claude"]
CARD_W        = 0.55    # card width  (baked into mesh)
CARD_H        = 0.85    # card height (baked into mesh)
FAN_RADIUS       = 0.80    # radius of the fan arc
DEG_PER_CARD     = 14.0    # angular gap between adjacent cards; total spread scales with hand size
MAX_ARC_DEG      = 160.0   # cap so a very large hand doesn't wrap past the player
EVT_DUR       = 60      # frames per animation event
EVT_OFFSET    = 10      # start events this many frames before the logged frame
TRADE_HEIGHT  = 3.0     # z-height of arc apex for trades / receives
TOTAL_FRAMES  = 133000

# Seat positions — board centre = (0,0,0), board outer edge ≈ 6 units
PLAYER_POS = {
    "gpt4o":    Vector(( 0.0,  10.0, 0.0)),
    "gemini":   Vector(( 9.5,   3.1, 0.0)),
    "grok":     Vector(( 5.9,  -8.1, 0.0)),
    "deepseek": Vector((-5.9,  -8.1, 0.0)),
    "claude":   Vector((-9.5,   3.1, 0.0)),
}

# ══════════════════════════════════════════════════════════════════════════════
# PLAYER GEOMETRY HELPERS
# ══════════════════════════════════════════════════════════════════════════════
def player_center(player):
    return PLAYER_POS[player]

def outward_angle(player):
    """Angle in degrees pointing FROM board centre TOWARD player seat."""
    p = PLAYER_POS[player]
    return math.degrees(math.atan2(p.y, p.x))

# ══════════════════════════════════════════════════════════════════════════════
# MATERIAL
# ══════════════════════════════════════════════════════════════════════════════
TEXTURE_DIR = r"C:\Users\Quinn\Downloads\catanai"

RESOURCE_COLORS = {
    "wheat": (0.95, 0.78, 0.10),
    "sheep": (0.40, 0.75, 0.30),
    "ore":   (0.45, 0.45, 0.55),
    "brick": (0.72, 0.25, 0.10),
    "wood":  (0.55, 0.35, 0.12),
}

def get_or_create_material(name):
    import os
    key = name.lower()
    for mat in bpy.data.materials:
        if mat.name.lower() == key:
            return mat

    mat = bpy.data.materials.new(name=key)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (300, 0)

    out = nodes.new("ShaderNodeOutputMaterial")
    out.location = (600, 0)
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    img_path = os.path.join(TEXTURE_DIR, f"{key}.jpg")
    if os.path.exists(img_path):
        # Load or reuse image datablock
        img = bpy.data.images.get(f"{key}.jpg")
        if img is None:
            img = bpy.data.images.load(img_path)

        tex = nodes.new("ShaderNodeTexImage")
        tex.image = img
        tex.location = (-200, 0)

        uv = nodes.new("ShaderNodeTexCoord")
        uv.location = (-500, 0)
        links.new(uv.outputs["UV"], tex.inputs["Vector"])
        links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    else:
        # Fallback to flat colour if jpg is missing
        c = RESOURCE_COLORS.get(key, (0.8, 0.8, 0.8))
        bsdf.inputs["Base Color"].default_value = (*c, 1.0)

    return mat

# ══════════════════════════════════════════════════════════════════════════════
# CARD FACTORY
# ══════════════════════════════════════════════════════════════════════════════
_card_counter = [0]
_card_rz      = {}   # id(obj) -> settled z-rotation; set on landing, read on departure

def spawn_card(resource, loc):
    """Create a resource card, bake scale/rotation, position at loc."""
    _card_counter[0] += 1
    bpy.ops.object.select_all(action='DESELECT')
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = f"card_{_card_counter[0]:04d}_{resource}"

    # Stand card upright, face pointing outward along +X
    obj.rotation_euler = Euler((math.radians(90), 0, math.radians(90)), 'XYZ')
    bpy.ops.object.transform_apply(rotation=True)
    obj.scale = (CARD_W, 1.0, CARD_H)
    bpy.ops.object.transform_apply(scale=True)

    obj.data.materials.clear()
    obj.data.materials.append(get_or_create_material(resource))
    obj.location = loc
    return obj

# ══════════════════════════════════════════════════════════════════════════════
# FAN POSITION CALCULATOR
# Returns (world Vector, z-rotation float) for card[i] in a hand of n cards.
# ══════════════════════════════════════════════════════════════════════════════
def fan_pos_rot(player, card_idx, total):
    n          = max(total, 1)
    total_arc  = min(DEG_PER_CARD * (n - 1), MAX_ARC_DEG)
    spread_deg = total_arc / max(n - 1, 1)
    start_arc  = 90.0 - total_arc / 2.0
    out_deg    = outward_angle(player)
    out_rad    = math.radians(out_deg)
    perp_rad   = out_rad - math.radians(90)
    center     = player_center(player)

    arc_rad  = math.radians(start_arc + card_idx * spread_deg)
    local_x  = FAN_RADIUS * math.cos(arc_rad)
    local_z  = FAN_RADIUS * math.sin(arc_rad)
    world_dx = local_x * math.cos(perp_rad)
    world_dy = local_x * math.sin(perp_rad)

    pos = Vector((
        center.x + world_dx + card_idx * 0.003 * math.cos(out_rad),
        center.y + world_dy + card_idx * 0.003 * math.sin(out_rad),
        local_z,
    ))
    rot_z = math.atan2(world_dy, world_dx) + math.radians(90)
    return pos, rot_z


def knight_pos(player, idx, total):
    """
    World position for the idx-th played knight card sitting face-up in front
    of (inward from) the player's hand fan.  Cards are centred as a row and
    spaced slightly wider than a card width.
    """
    center    = player_center(player)
    out_rad   = math.radians(outward_angle(player))
    # Step inward (toward board centre) from the player seat
    inward_dist  = FAN_RADIUS + 0.25
    inward_x     = -math.cos(out_rad) * inward_dist
    inward_y     = -math.sin(out_rad) * inward_dist
    # Perpendicular axis for side-by-side layout
    perp_rad  = out_rad - math.radians(90)
    spacing   = CARD_W + 0.55
    row_start = -(total - 1) * spacing / 2.0
    lateral   = row_start + idx * spacing
    return Vector((
        center.x + inward_x + lateral * math.cos(perp_rad),
        center.y + inward_y + lateral * math.sin(perp_rad),
        0.5,
    ))


def knight_rz(player):
    """Z-rotation that makes a knight card face outward toward the viewer."""
    return math.radians(outward_angle(player))


# ══════════════════════════════════════════════════════════════════════════════
# KEYFRAME HELPERS
# ══════════════════════════════════════════════════════════════════════════════
def kf_loc(obj, frame, loc):
    obj.location = loc
    obj.keyframe_insert("location", frame=frame)

def kf_rot(obj, frame, rz):
    obj.rotation_euler = Euler((0, 0, rz), 'XYZ')
    obj.keyframe_insert("rotation_euler", frame=frame)

def kf_scale(obj, frame, s):
    obj.scale = (s, s, s)
    obj.keyframe_insert("scale", frame=frame)


def apply_all_easing():
    """Set EASE_IN_OUT Bezier on every keyframe (works on Blender 3.x and 4.4+)."""
    def ease_fcurves(fcurves):
        for fc in fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = 'BEZIER'
                kp.easing = 'EASE_IN_OUT'

    for obj in bpy.data.objects:
        if not (obj.animation_data and obj.animation_data.action):
            continue
        action = obj.animation_data.action
        if hasattr(action, 'fcurves'):
            # Blender 3.x / legacy actions
            ease_fcurves(action.fcurves)
        elif hasattr(action, 'layers'):
            # Blender 4.4+ new action system
            for layer in action.layers:
                for strip in layer.strips:
                    if hasattr(strip, 'channelbags'):
                        for bag in strip.channelbags:
                            ease_fcurves(bag.fcurves)

# ══════════════════════════════════════════════════════════════════════════════
# SCENE CLEANUP  –  remove all card objects and materials from previous runs
# ══════════════════════════════════════════════════════════════════════════════
for obj in [o for o in bpy.data.objects if o.name.startswith("card_")]:
    bpy.data.objects.remove(obj, do_unlink=True)

for mat in [m for m in bpy.data.materials if m.name.lower() in RESOURCE_COLORS]:
    bpy.data.materials.remove(mat, do_unlink=True)

for img in [i for i in bpy.data.images if i.name.lower().replace(".jpg","") in RESOURCE_COLORS]:
    bpy.data.images.remove(img, do_unlink=True)

_card_counter[0] = 0

# ══════════════════════════════════════════════════════════════════════════════
# HAND STATE   hands[player] = list of (resource_str, blender_object)
# ══════════════════════════════════════════════════════════════════════════════
hands          = {p: [] for p in PLAYERS}
played_knights = {p: [] for p in PLAYERS}   # knight cards placed face-up in front of fan

# ══════════════════════════════════════════════════════════════════════════════
# HIGH-LEVEL ANIMATION ACTIONS
# All functions use fan_pos_rot() for start positions — never obj.location —
# so keyframes are always computed from logical hand state, not Python-side
# object positions which can drift after multiple ops on the same frame.
# All return the frame after the animation completes.
# ══════════════════════════════════════════════════════════════════════════════

def receive(player, resource, frame):
    """Spawn a card at centre, fly it to the player's hand; reflow existing cards."""
    frame  = max(1, frame - EVT_OFFSET)
    origin = Vector((0, 0, TRADE_HEIGHT))
    obj = spawn_card(resource, origin)

    kf_scale(obj, max(1, frame - 1), 0.0)
    kf_scale(obj, frame,             1.0)
    kf_loc(obj, frame, origin)
    kf_rot(obj, frame, 0.0)

    hands[player].append((resource, obj))
    n = len(hands[player])
    dst, rz = fan_pos_rot(player, n - 1, n)

    kf_loc(obj, frame + EVT_DUR, dst)
    kf_rot(obj, frame + EVT_DUR, rz)
    _card_rz[id(obj)] = rz   # record settled rotation for this card

    for i, (_, o) in enumerate(hands[player][:-1]):
        p_old, _ = fan_pos_rot(player, i, n - 1)
        p_new, _ = fan_pos_rot(player, i, n)
        kf_loc(o, frame,           p_old)
        kf_loc(o, frame + EVT_DUR, p_new)

    return frame + EVT_DUR


def trade(giver, taker, resource, frame):
    """
    Animate one resource card arcing from giver's hand to taker's hand.

    The card:
      frame          → start at computed fan position in giver's hand
      frame+DUR//2   → arc apex midway between seats, at TRADE_HEIGHT
      frame+DUR      → land at computed fan position in taker's hand

    Both hands reflow over the same interval.
    Start positions are always derived from fan_pos_rot, never from
    obj.location, so sequential calls chain cleanly.
    """
    idx = next((i for i, (r, _) in enumerate(hands[giver]) if r == resource), None)
    if idx is None:
        print(f"  [WARN] trade: {giver} has no '{resource}' — skipping")
        return frame + EVT_DUR

    res, obj = hands[giver].pop(idx)
    ng_before = len(hands[giver]) + 1   # giver hand size before removal
    ng_after  = len(hands[giver])       # giver hand size after removal

    # Start: computed fan slot in giver's pre-trade hand
    start_pos, start_rz = fan_pos_rot(giver, idx, ng_before)

    # Arc apex: midpoint between the two seats, elevated
    gc = player_center(giver)
    tc = player_center(taker)
    arc_pos   = Vector(((gc.x + tc.x) * 0.5, (gc.y + tc.y) * 0.5, TRADE_HEIGHT))
    mid_frame = frame + EVT_DUR // 2

    # Destination: end of taker's post-trade hand
    hands[taker].append((res, obj))
    nt = len(hands[taker])
    dst_pos, dst_rz = fan_pos_rot(taker, nt - 1, nt)

    # ── Animate the travelling card ───────────────────────────────────────────
    kf_loc(obj, frame,           start_pos)
    kf_loc(obj, mid_frame,       arc_pos)
    kf_loc(obj, frame + EVT_DUR, dst_pos)
    kf_rot(obj, frame,           start_rz)
    kf_rot(obj, mid_frame,       0.0)        # lie flat while airborne
    kf_rot(obj, frame + EVT_DUR, dst_rz)

    # ── Reflow giver's remaining cards ────────────────────────────────────────
    for i, (_, o) in enumerate(hands[giver]):
        p_old, _ = fan_pos_rot(giver, i, ng_before)
        p_new, _ = fan_pos_rot(giver, i, ng_after)
        kf_loc(o, frame,           p_old)
        kf_loc(o, frame + EVT_DUR, p_new)

    # ── Reflow taker's pre-existing cards ─────────────────────────────────────
    for i, (_, o) in enumerate(hands[taker][:-1]):
        p_old, _ = fan_pos_rot(taker, i, nt - 1)
        p_new, _ = fan_pos_rot(taker, i, nt)
        kf_loc(o, frame,           p_old)
        kf_loc(o, frame + EVT_DUR, p_new)

    return frame + EVT_DUR


def discard_multi(player, resources, frame, duration=120):
    """
    Discard multiple cards simultaneously.
    All matching cards converge to the centre, then rise and vanish together.
    Bystander cards slide to their new fan positions (position only, no
    rotation keyframes) to prevent Euler-interpolation flip artifacts.
    Returns the frame on which the animation completes.
    """
    frame      = max(1, frame - EVT_OFFSET)
    mid_frame  = frame + duration // 2
    end_frame  = frame + duration
    n_before   = len(hands[player])

    # ── Identify cards to remove ──────────────────────────────────────────────
    claimed = set()
    to_remove = []   # (orig_idx, obj)
    for resource in resources:
        idx = next(
            (i for i, (r, _) in enumerate(hands[player])
             if r == resource and i not in claimed),
            None,
        )
        if idx is None:
            print(f"  [WARN] discard_multi: {player} has no '{resource}' — skipping")
            continue
        claimed.add(idx)
        _, obj = hands[player][idx]
        to_remove.append((idx, obj))

    if not to_remove:
        return end_frame

    # ── Snapshot start positions before mutating the hand ────────────────────
    start_positions = {
        obj: fan_pos_rot(player, idx, n_before)[0]
        for idx, obj in to_remove
    }

    # ── Remove from hand in reverse-index order ───────────────────────────────
    removed_indices = set(idx for idx, _ in to_remove)
    for idx in sorted(removed_indices, reverse=True):
        hands[player].pop(idx)

    n_after = len(hands[player])

    # ── Animate discarded cards: spread slightly at centre, then rise + vanish ─
    n_rem = len(to_remove)
    spread = 0.5
    for k, (idx, obj) in enumerate(to_remove):
        start_pos = start_positions[obj]
        mid_pos   = Vector(((k - (n_rem - 1) / 2.0) * spread, 0, 1.0))
        gone_pos  = mid_pos + Vector((0, 0, 3.5))

        kf_loc(obj,   frame,      start_pos)
        kf_loc(obj,   mid_frame,  mid_pos)
        kf_loc(obj,   end_frame,  gone_pos)
        kf_scale(obj, frame,      1.0)
        kf_scale(obj, mid_frame,  1.0)
        kf_scale(obj, end_frame,  0.0)

    # ── Reflow bystanders: position only (no rotation — prevents flips) ───────
    remaining_orig = [i for i in range(n_before) if i not in removed_indices]
    for new_i, (orig_i, (_, o)) in enumerate(zip(remaining_orig, hands[player])):
        p_old, _ = fan_pos_rot(player, orig_i, n_before)
        p_new, _ = fan_pos_rot(player, new_i,  n_after)
        kf_loc(o, frame,     p_old)
        kf_loc(o, end_frame, p_new)

    return end_frame


def trade_multi(exchanges, frame, duration=120):
    """
    Animate a set of resource exchanges simultaneously.
    exchanges : list of (giver, taker, resource) tuples.
    All cards arc from givers to takers in parallel within `duration` frames.
    Bystander cards slide to their new fan positions via position keyframes
    only — no rotation keyframes — to prevent Euler-interpolation flip artifacts.
    Returns the frame on which all animations complete.
    """
    frame     = max(1, frame - EVT_OFFSET)
    mid_frame = frame + duration // 2
    end_frame  = frame + duration

    # ── 1. Snapshot hand sizes before any mutation ────────────────────────────
    sizes_before = {p: len(hands[p]) for p in PLAYERS}

    # ── 2. Identify card objects ──────────────────────────────────────────────
    claimed = {p: set() for p in PLAYERS}
    moves   = []   # (obj, giver, taker, res, orig_idx)

    for giver, taker, resource in exchanges:
        idx = next(
            (i for i, (r, _) in enumerate(hands[giver])
             if r == resource and i not in claimed[giver]),
            None,
        )
        if idx is None:
            print(f"  [WARN] trade_multi: {giver} has no '{resource}' — skipping")
            continue
        claimed[giver].add(idx)
        _, obj = hands[giver][idx]
        moves.append((obj, giver, taker, resource, idx))

    if not moves:
        return end_frame

    # ── 3. Compute start positions while hands are intact ─────────────────────
    start_info = {}   # id(obj) -> pos only (rz read from _card_rz on departure)
    for obj, giver, taker, res, idx in moves:
        pos, _ = fan_pos_rot(giver, idx, sizes_before[giver])
        start_info[id(obj)] = pos

    # ── 4. Remove from givers (reverse-index order keeps other indices valid) ──
    giver_removes = {}   # giver -> list of original indices removed
    for obj, giver, taker, res, idx in moves:
        giver_removes.setdefault(giver, []).append(idx)

    for giver, indices in giver_removes.items():
        for idx in sorted(indices, reverse=True):
            hands[giver].pop(idx)

    # ── 5. Snapshot taker sizes after giver removals, before additions ─────────
    taker_before = {p: len(hands[p]) for p in PLAYERS}

    # ── 6. Add cards to takers ────────────────────────────────────────────────
    for obj, giver, taker, res, idx in moves:
        hands[taker].append((res, obj))

    # ── 7. Compute destination positions ─────────────────────────────────────
    taker_slot = {p: 0 for p in PLAYERS}
    dst_info   = {}   # id(obj) -> (pos, rz)
    for obj, giver, taker, res, idx in moves:
        slot    = taker_before[taker] + taker_slot[taker]
        n_total = len(hands[taker])
        pos, rz = fan_pos_rot(taker, slot, n_total)
        dst_info[id(obj)] = (pos, rz)
        taker_slot[taker] += 1

    # ── 8. Keyframe the travelling cards ─────────────────────────────────────
    for obj, giver, taker, res, idx in moves:
        s_pos   = start_info[id(obj)]
        s_rz    = _card_rz.get(id(obj), 0.0)   # use tracked settled rz, not recomputed
        d_pos, d_rz = dst_info[id(obj)]
        gc      = player_center(giver)
        tc      = player_center(taker)
        arc_pos = Vector(((gc.x + tc.x) * 0.5, (gc.y + tc.y) * 0.5, TRADE_HEIGHT))

        # Pin the settled rotation one frame before departure so there is no
        # Bezier drift between the landing keyframe and this departure keyframe.
        kf_rot(obj, max(1, frame - 1), s_rz)
        kf_loc(obj, frame,     s_pos)
        kf_loc(obj, mid_frame, arc_pos)
        kf_loc(obj, end_frame, d_pos)
        kf_rot(obj, frame,     s_rz)
        kf_rot(obj, mid_frame, 0.0)
        kf_rot(obj, end_frame, d_rz)
        _card_rz[id(obj)] = d_rz   # record new settled rotation

    # ── 9. Reflow bystanders: position only (no rotation — prevents flips) ────
    # Giver bystanders: handles both pure-givers and players who give AND receive
    for giver, rem_indices in giver_removes.items():
        n_before = sizes_before[giver]
        n_after  = len(hands[giver])
        removed  = set(rem_indices)
        remaining_orig = [i for i in range(n_before) if i not in removed]
        for new_i, (orig_i, (_, o)) in enumerate(zip(remaining_orig, hands[giver])):
            p_old, _ = fan_pos_rot(giver, orig_i, n_before)
            p_new, _ = fan_pos_rot(giver, new_i,  n_after)
            kf_loc(o, frame,     p_old)
            kf_loc(o, end_frame, p_new)

    # Taker bystanders: skip players already handled by giver reflow above
    givers_set = set(giver_removes.keys())
    for taker in set(m[2] for m in moves):
        if taker in givers_set:
            continue
        n_before = taker_before[taker]
        n_after  = len(hands[taker])
        for i in range(n_before):
            _, o = hands[taker][i]
            p_old, _ = fan_pos_rot(taker, i, n_before)
            p_new, _ = fan_pos_rot(taker, i, n_after)
            kf_loc(o, frame,     p_old)
            kf_loc(o, end_frame, p_new)

    return end_frame


def build(player, costs, frame):
    """
    Cost cards converge to staggered spots at centre, shrink, and vanish.
    Identifies all cards to remove first, then animates from their correct
    pre-removal fan positions, correctly handling duplicate resource types.
    """
    ng_before = len(hands[player])

    # ── 1. Identify indices of cards to remove (no duplicates double-counted) ─
    claimed = set()
    to_remove_indices = []
    for resource in costs:
        idx = next(
            (i for i, (r, _) in enumerate(hands[player])
             if r == resource and i not in claimed),
            None
        )
        if idx is None:
            print(f"  [WARN] build: {player} has no '{resource}' — skipping card")
            continue
        claimed.add(idx)
        to_remove_indices.append(idx)

    if not to_remove_indices:
        return frame + EVT_DUR * 2

    # ── 2. Snapshot objects and their pre-removal fan positions ───────────────
    removed_cards = []
    for idx in sorted(to_remove_indices):
        pos, _ = fan_pos_rot(player, idx, ng_before)
        _, obj = hands[player][idx]
        removed_cards.append((obj, pos))

    # ── 3. Remove from hand in reverse order to preserve indices ──────────────
    for idx in sorted(to_remove_indices, reverse=True):
        hands[player].pop(idx)

    ng_after = len(hands[player])

    # ── 4. Animate removed cards converging to centre then vanishing ──────────
    n_rem = len(removed_cards)
    for k, (obj, start_pos) in enumerate(removed_cards):
        spread  = 0.5
        mid_pos  = Vector(((k - (n_rem - 1) / 2.0) * spread, 0, 1.2))
        gone_pos = mid_pos + Vector((0, 0, 3.5))
        kf_loc(obj,   frame,             start_pos)
        kf_loc(obj,   frame + EVT_DUR,   mid_pos)
        kf_loc(obj,   frame + EVT_DUR*2, gone_pos)
        kf_scale(obj, frame,             1.0)
        kf_scale(obj, frame + EVT_DUR,   1.0)
        kf_scale(obj, frame + EVT_DUR*2, 0.0)

    # ── 5. Reflow remaining hand using original slot indices ──────────────────
    remaining_orig = [i for i in range(ng_before) if i not in to_remove_indices]
    for new_i, (orig_i, (_, o)) in enumerate(zip(remaining_orig, hands[player])):
        p_old, _ = fan_pos_rot(player, orig_i, ng_before)
        p_new, _ = fan_pos_rot(player, new_i,  ng_after)
        kf_loc(o, frame,             p_old)
        kf_loc(o, frame + EVT_DUR*2, p_new)

    return frame + EVT_DUR * 2


def buy_dev_card(player, frame):
    """
    Pay ore+wheat+sheep (via build), then spawn a face-down dev card at the
    front of the player's fan (index 0) so it is always the most visible card.
    """
    build(player, ["ore", "wheat", "sheep"], frame)

    # Dev card arrives after the build animation completes
    arrive = frame + EVT_DUR * 2
    origin = Vector((0, 0, TRADE_HEIGHT))
    obj = spawn_card("dcs__back", origin)

    kf_scale(obj, max(1, arrive - 1), 0.0)
    kf_scale(obj, arrive,             1.0)
    kf_loc(obj,   arrive,             origin)
    kf_rot(obj,   arrive,             0.0)

    # Insert at front — dev cards occupy the left/first slot of the fan
    hands[player].insert(0, ("dcs__back", obj))
    n = len(hands[player])

    dst, rz = fan_pos_rot(player, 0, n)
    kf_loc(obj, arrive + EVT_DUR, dst)
    kf_rot(obj, arrive + EVT_DUR, rz)
    _card_rz[id(obj)] = rz

    # Reflow: every existing card shifts one slot toward the right
    for i, (_, o) in enumerate(hands[player][1:], 1):
        p_old, _ = fan_pos_rot(player, i - 1, n - 1)
        p_new, _ = fan_pos_rot(player, i,     n)
        kf_loc(o, arrive,           p_old)
        kf_loc(o, arrive + EVT_DUR, p_new)

    return arrive + EVT_DUR


def play_dev_card(player, frame):
    """Discard the front-most dev card from a player's hand."""
    return discard_multi(player, ["dcs__back"], frame)


def play_knight(player, frame):
    """
    Play a knight: the dcs__back card vanishes from the hand, and a new
    playedknight card spawns at the same position and flies to the knight row.
    This keeps the two materials on separate objects so neither bleeds into
    the other's lifetime on the timeline.
    """
    idx = next((i for i, (r, _) in enumerate(hands[player]) if r == "dcs__back"), None)
    if idx is None:
        print(f"  [WARN] play_knight: {player} has no dev card — skipping")
        return frame + EVT_DUR

    frame    = max(1, frame - EVT_OFFSET)
    n_before = len(hands[player])
    start_pos, start_rz = fan_pos_rot(player, idx, n_before)
    _, back_obj = hands[player].pop(idx)
    n_after = len(hands[player])

    # Hide the dcs__back card at this frame — it stays dcs__back its whole life
    kf_loc(back_obj,   frame, start_pos)
    kf_scale(back_obj, frame, 1.0)
    kf_scale(back_obj, frame + 1, 0.0)

    # Spawn a fresh playedknight card at the same position and fly it to the row
    knight_obj = spawn_card("playedknight", start_pos)
    kf_scale(knight_obj, max(1, frame - 1), 0.0)
    kf_scale(knight_obj, frame,             1.0)
    kf_rot(knight_obj,   frame,           start_rz)
    kf_loc(knight_obj,   frame,           start_pos)

    played_knights[player].append(knight_obj)
    n_knights = len(played_knights[player])
    dst_pos = knight_pos(player, n_knights - 1, n_knights)
    dst_rz  = knight_rz(player)

    kf_loc(knight_obj, frame + EVT_DUR, dst_pos)
    knight_obj.rotation_euler = Euler((0, math.radians(90), dst_rz), 'XYZ')
    knight_obj.keyframe_insert("rotation_euler", frame=frame + EVT_DUR)
    _card_rz[id(knight_obj)] = dst_rz

    # Reflow remaining hand cards
    remaining_orig = [i for i in range(n_before) if i != idx]
    for new_i, (orig_i, (_, o)) in enumerate(zip(remaining_orig, hands[player])):
        p_old, _ = fan_pos_rot(player, orig_i, n_before)
        p_new, _ = fan_pos_rot(player, new_i,  n_after)
        kf_loc(o, frame,           p_old)
        kf_loc(o, frame + EVT_DUR, p_new)

    # Reflow previous knights to keep the row centred
    for ki, ko in enumerate(played_knights[player][:-1]):
        p_old = knight_pos(player, ki, n_knights - 1)
        p_new = knight_pos(player, ki, n_knights)
        kf_loc(ko, frame,           p_old)
        kf_loc(ko, frame + EVT_DUR, p_new)

    return frame + EVT_DUR


def monopoly(player, resource, frame, duration=180):
    """
    Animate a Monopoly dev card: every other player's cards of `resource`
    fly simultaneously to `player`.  Uses trade_multi internally so all
    reflow logic is handled consistently.
    """
    exchanges = []
    for other in PLAYERS:
        if other == player:
            continue
        count = sum(1 for r, _ in hands[other] if r == resource)
        for _ in range(count):
            exchanges.append((other, player, resource))
    if not exchanges:
        print(f"  [INFO] monopoly: no '{resource}' cards held by other players — nothing to transfer")
        return frame
    return trade_multi(exchanges, frame, duration=duration)


# ══════════════════════════════════════════════════════════════════════════════
# INITIAL HANDS  –  place starting cards at frame 1, no animation
# ══════════════════════════════════════════════════════════════════════════════
STARTING_HANDS = {
    "gpt4o":    ["sheep", "ore"],
    "gemini":   ["ore"],
    "grok":     ["wood", "ore"],
    "deepseek": ["wood", "wheat", "sheep"],
    "claude":   ["wood", "brick", "ore"],
}

for player, cards in STARTING_HANDS.items():
    n_total = len(cards)
    for ci, res in enumerate(cards):
        pos, rz = fan_pos_rot(player, ci, n_total)
        obj = spawn_card(res, pos)
        obj.rotation_euler = Euler((0, 0, rz), 'XYZ')
        hands[player].append((res, obj))
        _card_rz[id(obj)] = rz

# ══════════════════════════════════════════════════════════════════════════════
# ANIMATION  –  Turns 1-18, events keyed to exact source frames.
# Bank trades use build() for outgoing resources and receive() +130 for the
# incoming resource so the "pay" animation completes before the card arrives.
# ══════════════════════════════════════════════════════════════════════════════

# ── TURN 1 ───────────────────────────────────────────────────────────────────

receive("gpt4o",    "sheep", 5892)
receive("deepseek", "sheep", 5893)
receive("deepseek", "sheep", 5894)
receive("claude",   "sheep", 5895)

receive("gpt4o",    "brick", 6357)
receive("gemini",   "ore",   6358)
receive("gemini",   "ore",   6359)
receive("deepseek", "brick", 6360)

receive("gpt4o", "wood", 6656)
receive("grok",  "wood", 6657)

trade_multi([("deepseek","grok","sheep"),("grok","deepseek","wood"),("grok","deepseek","ore")], 8326)
trade_multi([("deepseek","gemini","wheat"),("gemini","deepseek","ore"),("gemini","deepseek","ore")], 8855)

discard_multi("deepseek", ["wood","wood","sheep","sheep"], 9117)

trade_multi([("gemini","deepseek","ore")], 10236)
trade_multi([("claude","deepseek","wood")], 10544)

receive("deepseek", "wheat", 11222)
receive("claude",   "wood",  11223)
receive("claude",   "wood",  11224)

trade_multi([("claude","gemini","sheep"),("gemini","claude","wheat")], 11559)
trade_multi([("claude","grok","wood"),("grok","claude","sheep")], 12070)

build("claude", ["wood","brick"], 12258)
buy_dev_card("claude", 12338)

# ── TURN 2 ───────────────────────────────────────────────────────────────────

receive("gemini", "sheep", 12884)

trade_multi([("gpt4o","deepseek","sheep"),("deepseek","gpt4o","ore"),("deepseek","gpt4o","ore")], 13290)
build("gpt4o", ["wood","brick"], 13420)

receive("gpt4o", "wood", 13621)
receive("grok",  "wood", 13622)

trade_multi([("gemini","grok","sheep"),("grok","gemini","wood")], 13719)

receive("grok",     "ore", 14098)
receive("deepseek", "ore", 14099)

trade_multi([("deepseek","grok","ore"),("grok","deepseek","wood"),("grok","deepseek","wood")], 15436)

receive("grok",     "wood",  16207)
receive("grok",     "wheat", 16208)
receive("deepseek", "wood",  16209)
receive("claude",   "wheat", 16210)

build("deepseek", ["wood","brick"], 16326)
buy_dev_card("deepseek", 16625)

trade_multi([("claude","gpt4o","wheat"),("gpt4o","claude","wood"),("gpt4o","claude","ore"),("gpt4o","claude","ore")], 18779)

receive("gpt4o", "wheat", 18863)

# ── TURN 3 ───────────────────────────────────────────────────────────────────

receive("grok",     "ore", 19387)
receive("deepseek", "ore", 19388)

buy_dev_card("gpt4o", 19578)

# Gemini rolls 7 at 19858 — no discards

trade_multi([("deepseek","gemini","ore")], 20806)
trade_multi([("deepseek","gemini","ore")], 21998)  # Gemini robs DeepSeek

trade_multi([("gemini","grok","wood"),("grok","gemini","ore")], 22513)
trade_multi([("grok","gemini","wood"),("gemini","grok","ore"),("gemini","grok","sheep")], 23587)

receive("grok",     "wood",  23864)
receive("grok",     "wheat", 23865)
receive("deepseek", "wood",  23866)
receive("claude",   "wheat", 23867)

build("grok", ["wheat","wheat","ore","ore","ore"], 23961)

play_knight("deepseek", 24228)

trade_multi([("gemini","deepseek","ore")], 24713)
trade_multi([("claude","deepseek","wheat")], 25326)

receive("grok",     "wood",  25734)
receive("grok",     "wood",  25735)
receive("grok",     "wheat", 25736)
receive("deepseek", "wood",  25737)
receive("claude",   "wheat", 25738)

trade_multi([("claude","gemini","wheat"),("gemini","claude","ore")], 26124)

play_knight("gpt4o", 26284)

# ── TURN 4 ───────────────────────────────────────────────────────────────────

trade_multi([("grok","gpt4o","wheat")], 27264)  # ChatGPT steals from Grok

receive("gpt4o", "wheat", 27361)

receive("gpt4o",    "ore", 27538)
receive("grok",     "ore", 27539)
receive("grok",     "ore", 27540)
receive("deepseek", "ore", 27541)
receive("claude",   "ore", 27542)

discard_multi("deepseek", ["wood","wood","wood","wood"],   27890)
discard_multi("grok",     ["wood","wood","wood","sheep"],  27891)

trade_multi([("gpt4o","grok","ore")], 28843)
trade_multi([("deepseek","grok","ore")], 29296)  # Grok steals from DeepSeek

trade_multi([("deepseek","grok","wheat"),("grok","deepseek","ore"),("grok","deepseek","ore")], 30592)

# DeepSeek rolls 7 at 30903 — no discards listed

trade_multi([("claude","deepseek","wood")], 32398)  # DeepSeek steals from Claude

trade_multi([("claude","gpt4o","ore"),("claude","gpt4o","ore"),("gpt4o","claude","wheat"),("gpt4o","claude","wheat")], 33468)

receive("grok",     "wood",  33563)
receive("grok",     "wood",  33564)
receive("grok",     "wheat", 33565)
receive("deepseek", "wood",  33566)
receive("claude",   "wheat", 33567)

trade_multi([("claude","gpt4o","wheat"),("gpt4o","claude","ore"),("gpt4o","claude","ore")], 35168)

build("claude", ["wheat","wheat","ore","ore","ore"], 35387)

# ── TURN 5 ───────────────────────────────────────────────────────────────────

receive("gemini", "brick", 35959)
receive("grok",   "wood",  35960)
receive("claude", "brick", 35961)

# ChatGPT trades wheat for DeepSeek ore — no frame given, skipped

trade_multi([("grok","gpt4o","ore"),("gpt4o","grok","wheat")], 36262)

receive("grok",     "ore", 36587)
receive("grok",     "ore", 36588)
receive("deepseek", "ore", 36589)

receive("gpt4o", "wood", 37391)
receive("grok",  "wood", 37392)

build("grok", ["wheat","wheat","ore","ore","ore"], 37444)

trade_multi([("deepseek","gpt4o","wood"),("deepseek","gpt4o","wood"),("gpt4o","deepseek","ore")], 38206)

# DeepSeek rolls 7 at 38374 — no discards listed

trade_multi([("grok","deepseek","wheat")], 39641)  # DeepSeek steals from Grok

build("deepseek", ["wheat","wheat","ore","ore","ore"], 39904)

trade_multi([("claude","gemini","brick"),("gemini","claude","wheat")], 40581)

receive("gpt4o", "wood", 40694)
receive("grok",  "wood", 40695)
receive("grok",  "wood", 40696)

# ── TURN 6 ───────────────────────────────────────────────────────────────────

receive("gemini", "brick", 40738)
receive("grok",   "wood",  40739)
receive("grok",   "wood",  40740)
receive("claude", "brick", 40741)

trade_multi([("gpt4o","gemini","wood"),("gpt4o","gemini","wood"),("gpt4o","gemini","wood"),("gemini","gpt4o","brick")], 41868)
build("gpt4o", ["wood","brick"], 42021)

receive("gpt4o",    "brick", 42620)
receive("gemini",   "ore",   42621)
receive("gemini",   "ore",   42622)
receive("deepseek", "brick", 42623)
receive("deepseek", "brick", 42624)

trade_multi([("grok","gpt4o","wood"),("grok","gpt4o","wood"),("grok","gpt4o","wood"),("grok","gpt4o","wood"),("gpt4o","grok","brick")], 42902)

receive("gpt4o", "wood", 43031)
receive("grok",  "wood", 43032)
receive("grok",  "wood", 43033)

build("grok", ["wood","brick"], 43109)

receive("gpt4o",    "ore", 43875)
receive("grok",     "ore", 43876)
receive("grok",     "ore", 43877)
receive("deepseek", "ore", 43878)
receive("deepseek", "ore", 43879)
receive("claude",   "ore", 43880)
receive("claude",   "ore", 43881)

build("deepseek", ["wood","brick"], 44010)

discard_multi("gemini", ["wood","wood","ore","ore"],    44518)
discard_multi("grok",   ["wood","wood","wood","sheep"], 44519)

trade_multi([("gemini","claude","wood"),("gemini","claude","brick")], 44852)
trade_multi([("grok","claude","wood")], 45069)  # Claude steals from Grok

build("claude", ["wood","brick"], 45317)

# ── TURN 7 ───────────────────────────────────────────────────────────────────

trade_multi([("gpt4o","deepseek","wood"),("gpt4o","deepseek","wood"),("deepseek","gpt4o","ore")], 46026)

receive("gpt4o",    "sheep", 46157)
receive("deepseek", "sheep", 46158)
receive("deepseek", "sheep", 46159)
receive("claude",   "sheep", 46160)
receive("claude",   "sheep", 46161)

discard_multi("deepseek", ["wood","wood","sheep","sheep"], 47357)  # Gemini rolls 7

trade_multi([("claude","gemini","brick")], 47743)  # Gemini steals from Claude

trade_multi([("grok","gemini","ore"),("gemini","grok","brick")], 48525)

receive("gpt4o", "wheat", 48696)  # roll 11

receive("gpt4o", "wood", 48702)
receive("grok",  "wood", 48703)
receive("grok",  "wood", 48704)

build("grok", ["wood","brick"], 48764)

discard_multi("gpt4o", ["wood","wood","wood","wheat"], 49454)  # Claude rolls 7

trade_multi([("gemini","claude","ore")], 50303)
trade_multi([("gemini","claude","brick")], 50523)  # Claude steals from Gemini

build("claude", ["wood","brick","sheep","wheat"], 50766)

# ── TURN 8 ───────────────────────────────────────────────────────────────────

receive("gpt4o",    "sheep", 51497)
receive("deepseek", "sheep", 51498)
receive("deepseek", "sheep", 51499)
receive("deepseek", "sheep", 51500)
receive("claude",   "sheep", 51501)
receive("claude",   "sheep", 51502)

receive("grok",     "wood",  51822)
receive("grok",     "wood",  51823)
receive("grok",     "wheat", 51824)
receive("grok",     "wheat", 51825)
receive("deepseek", "wood",  51826)
receive("claude",   "wheat", 51827)
receive("claude",   "wheat", 51828)

build("grok", ["wood","wood","wood"], 52162)        # bank trade: 3 wood → 1 brick
receive("grok", "brick", 52162 + 130)

receive("gpt4o", "wood", 52353)
receive("grok",  "wood", 52354)
receive("grok",  "wood", 52355)

trade_multi([("deepseek","grok","brick"),("grok","deepseek","wood"),("grok","deepseek","wood"),("grok","deepseek","ore")], 52726)
trade_multi([("deepseek","gpt4o","sheep"),("gpt4o","deepseek","ore")], 53485)
trade_multi([("deepseek","grok","wood"),("deepseek","grok","wood"),("grok","deepseek","wheat")], 54314)

build("deepseek", ["ore","ore"], 54403)             # bank trade: 2 ore → 1 wheat (port)
receive("deepseek", "wheat", 54403 + 130)

receive("gpt4o", "wood", 54494)
receive("grok",  "wood", 54495)
receive("grok",  "wood", 54496)

receive("gpt4o",    "ore", 54655)
receive("grok",     "ore", 54656)
receive("grok",     "ore", 54657)
receive("deepseek", "ore", 54658)
receive("deepseek", "ore", 54659)
receive("claude",   "ore", 54660)
receive("claude",   "ore", 54661)

build("claude", ["wheat","wheat","ore","ore","ore"], 54697)

# ── TURN 9 ───────────────────────────────────────────────────────────────────

trade_multi([("gpt4o","deepseek","wood"),("gpt4o","deepseek","wood"),("deepseek","gpt4o","ore")], 55277)

discard_multi("grok",     ["wood","wood","wood","brick","wheat"], 55330)
discard_multi("deepseek", ["wood","wood","sheep","sheep"],        55331)
discard_multi("gpt4o",    ["wood","sheep","sheep","sheep"],       55332)

trade_multi([("grok","gpt4o","ore")], 55878)
trade_multi([("deepseek","gpt4o","wood")], 56568)  # ChatGPT steals from DeepSeek

receive("gemini", "brick", 56656)
receive("grok",   "wood",  56657)
receive("grok",   "wood",  56658)
receive("claude", "brick", 56659)
receive("claude", "brick", 56660)

build("gemini", ["wood","brick"], 56714)

# Grok rolls 7 at 57219 — no discards listed

trade_multi([("gpt4o","grok","ore")], 57963)
trade_multi([("deepseek","grok","ore")], 58453)  # Grok steals from DeepSeek

build("grok", ["wood","brick"], 58832)

trade_multi([("deepseek","claude","ore"),("deepseek","claude","ore"),("claude","deepseek","brick")], 59275)
trade_multi([("deepseek","gpt4o","wheat"),("gpt4o","deepseek","ore"),("gpt4o","deepseek","ore")], 59807)

receive("gpt4o",    "sheep", 60070)
receive("deepseek", "sheep", 60071)
receive("deepseek", "sheep", 60072)
receive("deepseek", "sheep", 60073)
receive("claude",   "sheep", 60074)
receive("claude",   "sheep", 60075)

build("deepseek", ["sheep","sheep","sheep","sheep"], 60119)  # bank trade: 4 sheep → 1 wood
receive("deepseek", "wood", 60119 + 130)

discard_multi("claude", ["sheep","sheep","sheep","sheep","ore"], 60180)

trade_multi([("gpt4o","claude","ore")], 61748)
trade_multi([("grok","claude","wood")], 62013)  # Claude steals from Grok

trade_multi([("claude","gpt4o","ore"),("gpt4o","claude","wheat")], 62762)
trade_multi([("claude","gpt4o","sheep"),("gpt4o","claude","ore")], 63829)

build("claude", ["wood","brick"], 64135)

# ── TURN 10 ──────────────────────────────────────────────────────────────────

trade_multi([("gpt4o","grok","sheep"),("grok","gpt4o","wood"),("grok","gpt4o","ore")], 65839)
trade_multi([("gpt4o","grok","wood"),("gpt4o","grok","wood"),("grok","gpt4o","ore")], 66594)

receive("gpt4o", "wood", 66824)
receive("grok",  "wood", 66825)
receive("grok",  "wood", 66826)

discard_multi("grok", ["wood","wood","wood","wood"], 66896)  # Gemini rolls 7

trade_multi([("gpt4o","gemini","ore")], 67337)
trade_multi([("gpt4o","gemini","sheep")], 67657)  # Gemini steals from ChatGPT

receive("gpt4o",    "brick", 67754)
receive("gemini",   "ore",   67755)
receive("gemini",   "ore",   67756)
receive("deepseek", "brick", 67757)
receive("deepseek", "brick", 67758)
receive("claude",   "ore",   67759)

trade_multi([("grok","deepseek","sheep"),("deepseek","grok","brick")], 68121)
trade_multi([("deepseek","grok","brick"),("grok","deepseek","wood")], 68970)

build("grok", ["wood","brick"], 69071)

trade_multi([("deepseek","gemini","wheat"),("gemini","deepseek","ore"),("gemini","deepseek","ore"),("gemini","deepseek","ore")], 70212)

receive("gpt4o", "wood", 70375)
receive("grok",  "wood", 70376)
receive("grok",  "wood", 70377)

build("deepseek", ["wood","brick"], 70833)

receive("grok",     "wood",  71286)
receive("grok",     "wood",  71287)
receive("grok",     "wheat", 71288)
receive("grok",     "wheat", 71289)
receive("deepseek", "wood",  71290)
receive("claude",   "wheat", 71291)
receive("claude",   "wheat", 71292)

build("claude", ["wheat","wheat","ore","ore","ore"], 71320)

# ── TURN 11 ──────────────────────────────────────────────────────────────────

trade_multi([("gpt4o","gemini","wood"),("gpt4o","gemini","wood"),("gemini","gpt4o","sheep")], 72136)

receive("grok",     "wood",  72183)
receive("grok",     "wood",  72184)
receive("grok",     "wheat", 72185)
receive("grok",     "wheat", 72186)
receive("deepseek", "wood",  72187)
receive("claude",   "wheat", 72188)
receive("claude",   "wheat", 72189)

trade_multi([("gpt4o","grok","brick"),("grok","gpt4o","wood"),("grok","gpt4o","wood")], 72377)

receive("grok",     "wood",  73209)
receive("grok",     "wood",  73210)
receive("grok",     "wheat", 73211)
receive("grok",     "wheat", 73212)
receive("deepseek", "wood",  73213)
receive("claude",   "wheat", 73214)
receive("claude",   "wheat", 73215)

receive("gpt4o",    "sheep", 73631)
receive("deepseek", "sheep", 73632)
receive("deepseek", "sheep", 73633)
receive("deepseek", "sheep", 73634)
receive("claude",   "sheep", 73635)
receive("claude",   "sheep", 73636)

trade_multi([("grok","gpt4o","wood"),("grok","gpt4o","wood"),("gpt4o","grok","sheep")], 74339)
trade_multi([("grok","deepseek","brick"),("deepseek","grok","ore"),("deepseek","grok","ore"),("deepseek","grok","ore")], 75822)

build("grok", ["wood","brick","sheep","wheat"], 75904)

discard_multi("claude",   ["wheat","wheat","sheep","sheep"],               76265)
discard_multi("grok",     ["wood","wood","wheat","wheat","wheat","wheat"], 76266)
discard_multi("deepseek", ["wood","wood","wood","sheep"],                  76267)

trade_multi([("claude","deepseek","wheat")], 77537)  # DeepSeek steals from Claude

trade_multi([("deepseek","gpt4o","sheep"),("gpt4o","deepseek","wood"),("gpt4o","deepseek","wood")], 78153)

build("deepseek", ["wood","brick","sheep","wheat"], 78387)

receive("gpt4o", "wheat", 78764)
receive("grok",  "sheep", 78765)

# ── TURN 12 ──────────────────────────────────────────────────────────────────

receive("grok",     "wood", 79918)
receive("grok",     "wood", 79919)
receive("deepseek", "wood", 79920)

trade_multi([("gpt4o","claude","sheep"),("gpt4o","claude","sheep"),("claude","gpt4o","wheat"),("claude","gpt4o","ore")], 80345)
trade_multi([("gpt4o","grok","wood"),("gpt4o","grok","wood"),("grok","gpt4o","ore")], 80763)

build("gpt4o", ["wheat","wheat","ore","ore","ore"], 81081)

trade_multi([("gemini","grok","brick"),("grok","gemini","ore"),("grok","gemini","ore")], 81881)

receive("grok",   "wood",  82026)
receive("grok",   "wood",  82027)
receive("grok",   "wood",  82028)
receive("claude", "brick", 82029)
receive("claude", "brick", 82030)
receive("gemini", "brick", 82031)

build("gemini", ["wood","wood"], 82124)             # bank trade: 2 wood → 1 brick
receive("gemini", "brick", 82124 + 130)

trade_multi([("grok","claude","wood"),("grok","claude","wood"),("grok","claude","wood"),("claude","grok","brick"),("claude","grok","sheep")], 82968)

receive("deepseek", "wheat", 83536)
receive("claude",   "wood",  83537)
receive("claude",   "wood",  83538)
receive("claude",   "wood",  83539)
receive("claude",   "wood",  83540)

build("grok", ["wood","brick"], 83586)

trade_multi([("deepseek","gemini","wheat"),("gemini","deepseek","brick"),("gemini","deepseek","ore")], 85205)
trade_multi([("deepseek","gemini","ore"),("gemini","deepseek","wheat")], 85609)

receive("gpt4o", "wood", 86009)
receive("gpt4o", "wood", 86010)
receive("grok",  "wood", 86011)
receive("grok",  "wood", 86012)

build("deepseek", ["wood","brick"], 86009)

receive("gpt4o",    "sheep", 86356)
receive("deepseek", "sheep", 86357)
receive("deepseek", "sheep", 86358)
receive("deepseek", "sheep", 86359)
receive("claude",   "sheep", 86360)
receive("claude",   "sheep", 86361)

build("claude", ["wood","brick"], 86960)
buy_dev_card("claude", 87146)

# ── TURN 13 ──────────────────────────────────────────────────────────────────

trade_multi([("gpt4o","gemini","sheep"),("gemini","gpt4o","ore")], 87575)

receive("gpt4o", "wheat", 87605)
receive("gpt4o", "wheat", 87606)
receive("grok",  "sheep", 87607)

receive("grok",     "wood", 87668)
receive("grok",     "wood", 87669)
receive("deepseek", "wood", 87670)

trade_multi([("gemini","grok","ore"),("grok","gemini","wood"),("grok","gemini","wood")], 88094)

receive("gpt4o",    "sheep", 88136)
receive("deepseek", "sheep", 88137)
receive("deepseek", "sheep", 88138)
receive("deepseek", "sheep", 88139)
receive("claude",   "sheep", 88140)
receive("claude",   "sheep", 88141)

build("grok", ["wood","brick","sheep","wheat"], 88207)

trade_multi([("deepseek","grok","wheat"),("grok","deepseek","ore"),("grok","deepseek","ore")], 89959)
trade_multi([("deepseek","gpt4o","sheep"),("gpt4o","deepseek","wheat")], 91238)

receive("gemini", "sheep", 91294)

buy_dev_card("deepseek", 91336)

play_knight("claude", 91402)

trade_multi([("gpt4o","claude","ore")], 92224)
trade_multi([("deepseek","claude","wood")], 92661)  # Claude steals from DeepSeek

trade_multi([("claude","gemini","wood"),("claude","gemini","wood"),("claude","gemini","wood"),("gemini","claude","wheat")], 93271)
trade_multi([("claude","gpt4o","sheep"),("claude","gpt4o","sheep"),("gpt4o","claude","ore")], 93766)

receive("gpt4o",    "sheep", 93928)
receive("deepseek", "sheep", 93929)
receive("deepseek", "sheep", 93930)
receive("deepseek", "sheep", 93931)
receive("claude",   "sheep", 93932)
receive("claude",   "sheep", 93933)

# ── TURN 14 ──────────────────────────────────────────────────────────────────

receive("gemini", "brick", 93990)
receive("grok",   "wood",  93991)
receive("grok",   "wood",  93992)
receive("grok",   "wood",  93993)
receive("grok",   "wood",  93994)
receive("claude", "brick", 93995)
receive("claude", "brick", 93996)

trade_multi([("gpt4o","gemini","sheep"),("gpt4o","gemini","sheep"),("gemini","gpt4o","brick")], 94275)

build("gpt4o", ["wood","brick","sheep","wheat"], 94425)

receive("gpt4o", "wood", 94762)
receive("gpt4o", "wood", 94763)
receive("grok",  "wood", 94764)
receive("grok",  "wood", 94765)

receive("grok",     "wood",  94865)
receive("grok",     "wood",  94866)
receive("grok",     "wheat", 94867)
receive("grok",     "wheat", 94868)
receive("deepseek", "wood",  94869)
receive("claude",   "wheat", 94870)
receive("claude",   "wheat", 94871)

build("grok", ["wood","wood","wood"], 94986)        # bank trade: 3 wood → 1 brick
receive("grok", "brick", 94986 + 130)

play_knight("deepseek", 95080)

trade_multi([("grok","deepseek","wood"),("grok","deepseek","wood")], 96956)
trade_multi([("claude","deepseek","wood")], 97170)  # DeepSeek steals from Claude

receive("gpt4o",    "brick", 97354)
receive("deepseek", "brick", 97355)

trade_multi([("deepseek","grok","sheep"),("deepseek","grok","sheep"),("grok","deepseek","wheat")], 98259)

build("deepseek", ["wood","brick"], 98314)

discard_multi("grok",     ["wood","wood","wood","wood","wood","sheep","sheep"],    98404)
discard_multi("deepseek", ["wood","wood","sheep","sheep","sheep","sheep"],         98405)
discard_multi("claude",   ["wood","wood","brick","wheat","sheep","sheep","sheep"], 98406)
discard_multi("gemini",   ["wood","sheep","sheep","sheep"],                        98407)

trade_multi([("deepseek","claude","ore")], 99982)
trade_multi([("grok","claude","wheat")], 100495)  # Claude steals from Grok

build("claude", ["wood","brick","sheep","wheat"], 100590)

# ── TURN 15 ──────────────────────────────────────────────────────────────────

receive("grok",     "wood", 101075)
receive("grok",     "wood", 101076)
receive("deepseek", "wood", 101077)

trade_multi([("gpt4o","gemini","brick"),("gemini","gpt4o","wood"),("gemini","gpt4o","wood"),("gemini","gpt4o","wood")], 101555)

build("gpt4o", ["wood","wood","wood","wood"], 101641)   # bank trade: 4 wood → 1 ore
receive("gpt4o", "ore", 101641 + 130)

receive("gpt4o",    "brick", 101762)
receive("gpt4o",    "brick", 101763)
receive("gpt4o",    "brick", 101764)
receive("gemini",   "ore",   101765)
receive("gemini",   "ore",   101766)
receive("deepseek", "brick", 101767)
receive("deepseek", "brick", 101768)
receive("claude",   "ore",   101769)
receive("claude",   "ore",   101770)

trade_multi([("gemini","grok","brick"),("gemini","grok","sheep"),("grok","gemini","wood"),("grok","gemini","wood")], 102636)
trade_multi([("gemini","grok","wood"),("gemini","grok","wood"),("gemini","grok","ore"),("gemini","grok","ore"),("grok","gemini","sheep"),("grok","gemini","wheat")], 103253)
trade_multi([("grok","gemini","wood"),("grok","gemini","wood"),("gemini","grok","wheat")], 103537)

build("grok", ["wheat"], 104154)                    # bank trade: 1 wheat → 1 brick (port)
receive("grok", "brick", 104154 + 130)

receive("gpt4o",    "brick", 104400)
receive("gpt4o",    "brick", 104401)
receive("gpt4o",    "brick", 104402)
receive("gemini",   "ore",   104403)
receive("gemini",   "ore",   104404)
receive("deepseek", "brick", 104405)
receive("deepseek", "brick", 104406)
receive("claude",   "ore",   104407)
receive("claude",   "ore",   104408)

build("grok", ["wood","brick"], 104493)
build("grok", ["wood","brick"], 104493 + 130)

receive("gpt4o", "wheat", 104895)
receive("gpt4o", "wheat", 104896)
receive("gpt4o", "sheep", 104897)
receive("grok",  "sheep", 104898)

build("deepseek", ["wood","brick"], 105646)
build("deepseek", ["wood","brick","sheep","wheat"], 105646 + 130)

receive("gpt4o",    "brick", 105839)
receive("gpt4o",    "brick", 105840)
receive("gpt4o",    "brick", 105841)
receive("gemini",   "ore",   105842)
receive("gemini",   "ore",   105843)
receive("deepseek", "brick", 105844)
receive("deepseek", "brick", 105845)
receive("claude",   "ore",   105846)
receive("claude",   "ore",   105847)

build("claude", ["wheat","wheat","ore","ore","ore"], 106936)

# ── TURN 16 ──────────────────────────────────────────────────────────────────

trade_multi([("gpt4o","gemini","brick"),("gpt4o","gemini","brick"),("gpt4o","gemini","brick"),("gemini","gpt4o","ore"),("gemini","gpt4o","ore"),("gemini","gpt4o","ore")], 107553)

discard_multi("gemini", ["wood","brick","brick","sheep"],                            107593)
discard_multi("gpt4o",  ["wood","brick","brick","brick","brick","wheat","sheep","sheep"], 107594)

trade_multi([("claude","gpt4o","ore")], 108169)  # ChatGPT steals from Claude
build("gpt4o", ["wheat","wheat","ore","ore","ore"], 108523)

receive("gpt4o", "wheat", 108580)
receive("gpt4o", "wheat", 108581)
receive("gpt4o", "sheep", 108582)
receive("grok",  "sheep", 108583)

trade_multi([("grok","gpt4o","sheep"),("grok","gpt4o","sheep"),("grok","gpt4o","wood"),("gpt4o","grok","brick")], 109450)

receive("gpt4o",    "sheep", 109665)
receive("gpt4o",    "sheep", 109666)
receive("deepseek", "sheep", 109667)
receive("deepseek", "sheep", 109668)
receive("deepseek", "sheep", 109669)
receive("claude",   "sheep", 109670)
receive("claude",   "sheep", 109671)
receive("claude",   "sheep", 109672)
receive("claude",   "sheep", 109673)

trade_multi([("deepseek","gpt4o","sheep"),("deepseek","gpt4o","sheep"),("gpt4o","deepseek","wheat")], 111084)
trade_multi([("deepseek","gpt4o","brick"),("gpt4o","deepseek","wheat"),("gpt4o","deepseek","ore")], 111838)

receive("gemini", "brick", 112102)
receive("grok",   "wood",  112103)
receive("grok",   "wood",  112104)
receive("grok",   "wood",  112105)
receive("grok",   "wood",  112106)
receive("claude", "brick", 112107)
receive("claude", "brick", 112108)

build("deepseek", ["wood","brick"], 112187)
buy_dev_card("deepseek", 112276)

receive("gpt4o",    "sheep", 112315)
receive("gpt4o",    "sheep", 112316)
receive("deepseek", "sheep", 112317)
receive("deepseek", "sheep", 112318)
receive("deepseek", "sheep", 112319)
receive("claude",   "sheep", 112320)
receive("claude",   "sheep", 112321)
receive("claude",   "sheep", 112322)
receive("claude",   "sheep", 112323)

# ── TURN 17 ──────────────────────────────────────────────────────────────────

trade_multi([("gpt4o","grok","sheep"),("grok","gpt4o","brick"),("grok","gpt4o","ore")], 114688)

receive("grok",     "wood",  114925)
receive("grok",     "wood",  114926)
receive("grok",     "wheat", 114927)
receive("grok",     "wheat", 114928)
receive("deepseek", "wood",  114929)
receive("claude",   "wheat", 114930)
receive("claude",   "wheat", 114931)

trade_multi([("gpt4o","grok","sheep"),("grok","gpt4o","wheat")], 115382)
build("gpt4o", ["wood","brick"], 115711)

receive("gpt4o",    "sheep", 116452)
receive("gpt4o",    "sheep", 116453)
receive("deepseek", "sheep", 116454)
receive("deepseek", "sheep", 116455)
receive("deepseek", "sheep", 116456)
receive("claude",   "sheep", 116457)
receive("claude",   "sheep", 116458)
receive("claude",   "sheep", 116459)
receive("claude",   "sheep", 116460)

trade_multi([("gemini","grok","brick"),("gemini","grok","brick"),("grok","gemini","wood"),("grok","gemini","wood")], 117219)
trade_multi([("grok","gemini","brick"),("gemini","grok","wood"),("gemini","grok","wood")], 118250)

receive("grok",     "ore", 118590)
receive("grok",     "ore", 118591)
receive("deepseek", "ore", 118592)
receive("deepseek", "ore", 118593)
receive("deepseek", "ore", 118594)

build("grok", ["wood","brick"], 118663)
buy_dev_card("grok", 118663 + 130)

receive("grok",     "wood",  118926)
receive("grok",     "wood",  118927)
receive("grok",     "wheat", 118928)
receive("grok",     "wheat", 118929)
receive("deepseek", "wood",  118930)
receive("claude",   "wheat", 118931)
receive("claude",   "wheat", 118932)

trade_multi([("deepseek","grok","sheep"),("deepseek","grok","sheep"),("grok","deepseek","wheat")], 119250)

receive("gemini", "brick", 119442)
receive("grok",   "wood",  119443)
receive("grok",   "wood",  119444)
receive("grok",   "wood",  119445)
receive("grok",   "wood",  119446)
receive("claude", "brick", 119447)
receive("claude", "brick", 119448)

buy_dev_card("claude", 119513)

# ── TURN 18 ──────────────────────────────────────────────────────────────────

trade_multi([("gpt4o","grok","sheep"),("gpt4o","grok","sheep"),("gpt4o","grok","sheep"),("grok","gpt4o","wood"),("grok","gpt4o","wood")], 120705)
trade_multi([("gpt4o","grok","sheep"),("gpt4o","grok","sheep"),("gpt4o","grok","sheep"),("grok","gpt4o","ore")], 121081)

receive("deepseek", "wheat", 121220)
receive("deepseek", "wheat", 121221)
receive("claude",   "wood",  121222)
receive("claude",   "wood",  121223)
receive("claude",   "wood",  121224)
receive("claude",   "wood",  121225)

play_dev_card("gpt4o", 121651)
monopoly("gpt4o", "sheep", 121651)

build("gpt4o", ["wood","brick"], 122092)

receive("gpt4o",    "sheep", 122357)
receive("gpt4o",    "sheep", 122358)
receive("deepseek", "sheep", 122359)
receive("deepseek", "sheep", 122360)
receive("deepseek", "sheep", 122361)
receive("deepseek", "sheep", 122362)
receive("claude",   "sheep", 122363)
receive("claude",   "sheep", 122364)
receive("claude",   "sheep", 122365)
receive("claude",   "sheep", 122366)

play_knight("grok", 122792)

trade_multi([("deepseek","grok","wheat")], 123992)  # Grok steals from DeepSeek

trade_multi([("grok","gemini","wood"),("grok","gemini","wood"),("gemini","grok","brick")], 124683)

receive("gpt4o", "wood", 124737)
receive("gpt4o", "wood", 124738)
receive("grok",  "wood", 124739)
receive("grok",  "wood", 124740)

trade_multi([("grok","gpt4o","wood"),("grok","gpt4o","wood"),("gpt4o","grok","sheep")], 125266)

build("grok", ["wood","brick","sheep","wheat"], 125657)

build("deepseek", ["ore","ore","ore","ore"], 128559)    # bank trade: 4 ore → 1 sheep
receive("deepseek", "sheep", 128559 + 130)

discard_multi("claude",   ["wood","wood","brick","brick","wheat","wheat","sheep","sheep","ore","ore"], 128600)
discard_multi("gpt4o",    ["wood","wood","wood","sheep","sheep","sheep"],                              128601)
discard_multi("grok",     ["wood","wood","wood","wood"],                                               128602)
discard_multi("deepseek", ["wood","wheat","sheep","sheep","sheep","sheep"],                            128603)

trade_multi([("gpt4o","deepseek","ore")], 129368)
trade_multi([("claude","deepseek","brick")], 129557)  # DeepSeek steals from Claude

receive("gemini", "brick", 129747)
receive("grok",   "wood",  129748)
receive("grok",   "wood",  129749)
receive("grok",   "wood",  129750)
receive("grok",   "wood",  129751)
receive("claude", "brick", 129752)
receive("claude", "brick", 129753)

play_knight("claude", 129779)

trade_multi([("deepseek","claude","brick")], 130338)
trade_multi([("deepseek","claude","wood")], 130727)  # Claude robs DeepSeek

build("claude", ["wood","brick"], 131002)
build("claude", ["wood","brick","sheep","wheat"], 131083)

print("Turn 18 complete.")

# Apply smooth easing to all keyframes
apply_all_easing()

# ══════════════════════════════════════════════════════════════════════════════
# SCENE: CAMERA + LIGHTING + RENDER
# ══════════════════════════════════════════════════════════════════════════════
bpy.ops.object.camera_add(location=(0, -18, 12))
cam = bpy.context.active_object
cam.name = "Camera"
cam.rotation_euler = Euler((math.radians(55), 0, 0), 'XYZ')
bpy.context.scene.camera = cam

bpy.ops.object.light_add(type='SUN', location=(4, -6, 10))
sun = bpy.context.active_object
sun.data.energy = 5.0
sun.rotation_euler = Euler((math.radians(40), 0, math.radians(30)), 'XYZ')

bpy.ops.object.light_add(type='AREA', location=(-5, 5, 8))
fill = bpy.context.active_object
fill.data.energy = 400.0
fill.data.size   = 6.0

scene = bpy.context.scene
scene.frame_end             = TOTAL_FRAMES
scene.render.fps            = 30
scene.render.engine         = 'CYCLES'
scene.cycles.samples        = 64
scene.render.resolution_x   = 1920
scene.render.resolution_y   = 1080

world = bpy.data.worlds["World"]
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value    = (0.05, 0.05, 0.08, 1.0)
bg.inputs["Strength"].default_value = 0.3

bpy.context.scene.frame_set(1)
print("Done — press Space to play the animation.")
