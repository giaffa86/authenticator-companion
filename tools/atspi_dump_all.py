import sys, gi
gi.require_version('Atspi','2.0')
from gi.repository import Atspi
Atspi.init()

def walk(node, depth=0, maxdepth=14):
    if depth > maxdepth: return
    try:
        name = node.get_name(); role = node.get_role_name(); n = node.get_child_count()
    except Exception: return
    extra=""
    try:
        act = node.get_action_iface()
        if act:
            extra = " actions=" + str([act.get_action_name(i) for i in range(act.get_n_actions())])
    except Exception: pass
    print("  "*depth + f"[{role}] {name!r} c={n}{extra}")
    for i in range(n):
        try: walk(node.get_child_at_index(i), depth+1, maxdepth)
        except Exception: pass

target = sys.argv[1] if len(sys.argv)>1 else None
desktop = Atspi.get_desktop(0)
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    if target and target.lower() not in (app.get_name() or '').lower(): continue
    print(f"=== APP {app.get_name()} pid={Atspi.Accessible.get_process_id(app)} ===")
    walk(app)
