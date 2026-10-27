// macOS only: lists on-screen normal windows front to back (CoreGraphics; needs no
// accessibility permission). Windows of the given pid are marked OURS.
// osascript -l JavaScript windows.jxa.js <pid>
ObjC.import("CoreGraphics");
// oxlint-disable-next-line no-unused-vars -- JXA calls run() as the entry point
function run(argv) {
  const pid = Number(argv[0]);
  const list = ObjC.castRefToObject(
    $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0),
  );
  const out = [];
  for (let i = 0; i < list.count; i++) {
    const w = list.objectAtIndex(i);
    if (ObjC.unwrap(w.objectForKey("kCGWindowLayer")) !== 0) continue;
    const opid = ObjC.unwrap(w.objectForKey("kCGWindowOwnerPID"));
    const b = w.objectForKey("kCGWindowBounds");
    const n = (k) => ObjC.unwrap(b.objectForKey(k));
    out.push(
      `${out.length} ${opid === pid ? "OURS" : ObjC.unwrap(w.objectForKey("kCGWindowOwnerName"))} x=${n("X")} y=${n("Y")} w=${n("Width")} h=${n("Height")}`,
    );
  }
  return out.slice(0, 12).join("\n");
}
