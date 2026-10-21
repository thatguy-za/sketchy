// Turns the kernel's short error messages into advice an assistant (or a person) can act on: what is probably wrong and which
// field to change. The message itself is always kept; the hint is added next to it.
const RULES = [
  [/has no closed profile|no closed profile/i, (m, f) => `The sketch has no closed shape to turn into a solid. Close the outline (a "path" without "open", or a rect/circle/slot), or if it is a line for a sweep or revolve use that feature instead. Check with get_design that the sketch "${f?.params?.sketch || ''}" holds shapes.`],
  [/has no shapes|no shapes to revolve/i, () => 'The sketch is empty. Add shapes to it with edit_sketch (add_shapes) or add_feature kind "sketch" with params.shapes.'],
  [/Choose a sketch|Sketch not found|Choose a profile sketch|Choose a path sketch/i, (m, f) => `Set params.sketch to the id of a sketch feature that comes earlier in the timeline (get_design lists them). It is currently ${JSON.stringify(f?.params?.sketch ?? '')}.`],
  [/Referenced body no longer exists|Choose two different bodies|Target and tool must differ|Tool must be a different body/i, () => 'A body id is missing or repeated. Body ids change when earlier features change: call inspect_design for the current ones and pass them again.'],
  [/picked faces?.*(no longer exists|not a flat face)|face.*not a flat face of this body|no longer exists — pick it again/i, () => 'A picked face is gone or no longer flat. Call find_faces for this body and pass the new face (point and normal) in the same field.'],
  [/None of the \d+ picked edges? could|Select at least one edge|picked edges/i, () => 'The picked edges were not found. Call find_edges for the body (for example filter by direction or position) and pass the returned "ref" values in params.edges.'],
  [/Size too large for this edge|Wall thickness is too large|Wall is too thick|Thickness is too large/i, () => 'The value is bigger than the geometry allows. Try a smaller size (under half of the thinnest wall or the shortest edge involved), or use find_edges / inspect_design to see how big the part is.'],
  [/Taper angle too large/i, () => 'Reduce the taper angle, or make the extrude shorter: a tapered profile cannot shrink past nothing.'],
  [/Taper cannot be combined/i, () => 'Remove the taper, or switch off Symmetric / Thin extrude. Those options cannot be used together.'],
  [/Press\/Pull works on flat faces only/i, () => 'Choose a flat face. find_faces with type "planar" lists them. For a curved surface use fillet, shell or a new extrude instead.'],
  [/The tool bodies do not overlap|No enclosed space/i, () => 'The bodies do not touch or enclose anything. Check the positions with inspect_design (bounding boxes) and move one so that they overlap.'],
  [/Distance must be positive|Diameter must be positive|Diameter and depth must be positive|Size must be positive|Thickness must be positive|Scale factors must be positive/i, (m, f) => `A size is zero or negative. Check params of ${f?.name || 'this feature'}: every length must be above 0. If a value comes from an expression, check the named parameters with get_design.`],
  [/Counterbore diameter must exceed|Countersink diameter must exceed/i, () => 'Make the counterbore or countersink diameter larger than the hole diameter.'],
  [/Draft angle must be under 45/i, () => 'Use a draft angle under 45 degrees (1 to 5 is typical for moulded parts).'],
  [/profile crosses the axis/i, () => 'The sketch crosses the revolve axis. Draw the whole profile on one side of the axis, or choose a different axis.'],
  [/no centerline/i, () => 'Add a shape {"t":"path","open":true,"lt":"centerline","pts":[[x1,y1],[x2,y2]]} to the sketch, or set params.axis to "x" or "y".'],
  [/behind the profile|flip the direction/i, () => 'Set a negative distance, or flip params.flip, so the extrude goes the other way.'],
  [/Could not build a valid solid/i, () => 'The result folds over itself. Make the path smoother or the profile smaller than the path\'s bends, or reduce the twist.'],
  [/Nothing of the surface is left/i, () => 'The plane removes the whole surface. Move the plane (offset) so part of the surface stays on the side you keep.'],
  [/Sketch has no closed profile|selected profiles no longer exist/i, () => 'Clear params.profiles (set it to null) so every closed profile in the sketch is used, or re-select profiles that exist.'],
  [/Unknown feature|unknown primitive/i, () => 'Use a kind from describe_feature_types.'],
  [/not a closed shell yet/i, () => 'Stitch needs surfaces that completely enclose a volume. Add the missing surface, or increase the tolerance.'],
  [/This body is one connected piece/i, () => 'Nothing to separate: the body is a single solid.'],
  [/Wall thickness is too large for this diameter/i, () => 'Use a wall thinner than the radius.'],
];
const BY_TYPE = {
  extrude: 'Check params.sketch, params.distance and params.op. An extrude needs a sketch with a closed shape.',
  revolve: 'Check params.sketch, params.axis and params.angle. The profile must sit on one side of the axis.',
  fillet: 'Check params.edges and params.radius. Edges come from find_edges.',
  chamfer: 'Check params.edges and params.distance. Edges come from find_edges.',
  shell: 'Check params.body, params.thickness and the faces to remove (params.open).',
  hole: 'Check params.pos (a point on the face), params.dir (the face normal), the diameter and depth.',
};

/** A hint for a failed feature, or '' when there is nothing useful to add. */
export function hintFor(message, feature) {
  const m = String(message || '');
  for (const [re, fn] of RULES) if (re.test(m)) return fn(m, feature);
  return (feature && BY_TYPE[feature.type]) || '';
}
