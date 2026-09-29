import sys, gi
gi.require_version('Atspi','2.0')
from gi.repository import Atspi, GLib
Atspi.set_timeout(3000, 3000)
Atspi.init()
role_filter = sys.argv[1] if len(sys.argv)>1 else None
app_sub = sys.argv[2] if len(sys.argv)>2 else None
desktop = Atspi.get_desktop(0)
found=[]
def walk(node, depth=0):
    if depth>18: return
    try:
        role=node.get_role_name(); name=node.get_name(); n=node.get_child_count()
    except Exception: return
    if (role_filter is None or role_filter in role) :
        found.append((role,name,node))
    for i in range(n):
        try: walk(node.get_child_at_index(i), depth+1)
        except Exception: pass
for i in range(desktop.get_child_count()):
    app=desktop.get_child_at_index(i)
    if app_sub and app_sub.lower() not in (app.get_name() or '').lower(): continue
    walk(app)
print("count:", len(found))
for role,name,node in found[:60]:
    print(f"  [{role}] {name!r}")
