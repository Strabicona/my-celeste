using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.InteropServices.JavaScript;
using System.Threading.Tasks;

// Per-lobby map loading (asked 16 Nov 2026).
//
// Celeste loads every map completely at startup and keeps it in memory. With
// Strawberry Jam that is 128 maps and ~1.3 GB, and every full memory clean-up
// has to walk all of it (500-700 ms on the work Chromebook). Here, after
// startup, the heavy part of each map (its rooms: tiles, objects, decorations)
// is dropped, and only the maps of the group being played are kept complete.
// A map's summary stays for every map (strawberries, golden berries, hearts,
// checkpoints, totals), so lobbies, the journal and overworld totals still see
// all maps; the player's progress lives in the save file anyway.
//
// Groups: a map belongs to its folder ("StrawberryJam2021/2-Intermediate"); a
// lobby ("StrawberryJam2021/0-Lobbies/2-Intermediate") loads that folder.
// Lobbies, gyms and vanilla maps are never touched. Just before any level
// starts loading, its group is loaded and the other groups' rooms dropped.
public static partial class CelesteLoader
{
    static bool slimOn;
    static bool slimInstalled;
    static string slimGroup;
    static readonly HashSet<object> slimStripped = new(ReferenceEqualityComparer.Instance);
    static readonly string[] SlimTexts = { "Solids", "Bg", "FgTiles", "BgTiles", "ObjTiles" };
    static readonly string[] SlimLists = { "Entities", "Triggers", "FgDecals", "BgDecals" };

    // the page turns it on or off before the game reaches the title screen
    [JSExport]
    internal static Task<string> StartSlimMaps(bool on)
    {
        slimOn = on;
        if (!on) return Task.FromResult("off");
        return Task.Run(async () =>
        {
            // wait for the title screen (startup finished, every map loaded)
            for (int i = 0; i < 2400; i++)
            {
                try
                {
                    var scene = celeste?.GetType("Monocle.Engine")?.GetProperty("Scene", BindingFlags.Static | BindingFlags.Public)?.GetValue(null);
                    var name = scene?.GetType().FullName;
                    if (scene != null && name != "Celeste.GameLoader")
                    {
                        OnGameThread(scene, () =>
                        {
                            try
                            {
                                if (!InstallSlimHook()) { slimOn = false; return; }
                                var clock = Stopwatch.StartNew();
                                var before = GC.GetTotalMemory(false) / (1024 * 1024);
                                int n = SlimEnsure(null, null);
                                var after = GC.GetTotalMemory(true) / (1024 * 1024);
                                Console.WriteLine($"[slim] on: dropped rooms of {n} maps in {clock.ElapsedMilliseconds} ms, memory {before} -> {after} MB");
                            }
                            catch (Exception e) { slimOn = false; Console.WriteLine("[slim] failed, off: " + (e.InnerException ?? e).Message); }
                        });
                        return "waiting for the game thread";
                    }
                }
                catch { }
                await Task.Delay(500);
            }
            return "title screen never came";
        });
    }

    // runs once at the end of the next frame, on the game's own thread
    static void OnGameThread(object scene, Action act)
    {
        var ev = scene.GetType().GetEvent("OnEndOfFrame", BindingFlags.Instance | BindingFlags.Public);
        if (ev == null) { Console.WriteLine("[slim] no OnEndOfFrame"); return; }
        ev.AddEventHandler(scene, act);
    }

    // Everest.Events.Level.OnEnter: raised at the start of LevelEnter.Go, before
    // the level starts loading (lobbies, maps, Continue from a file). Restarting
    // or dying stays in the same map, which is already complete.
    static bool InstallSlimHook()
    {
        if (slimInstalled) return true;
        var ev = celeste.GetType("Celeste.Mod.Everest+Events+Level")?.GetEvent("OnEnter", BindingFlags.Static | BindingFlags.Public);
        if (ev == null) { Console.WriteLine("[slim] off: no Everest Level.OnEnter event"); return false; }
        var reload = celeste.GetType("Celeste.MapData")?.GetMethod("Reload", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
        if (reload == null) { Console.WriteLine("[slim] off: MapData.Reload missing"); return false; }
        var handlerType = ev.EventHandlerType;
        var ps = handlerType.GetMethod("Invoke").GetParameters().Select(p => Expression.Parameter(p.ParameterType, p.Name)).ToArray();
        var session = ps.First(p => p.Type.Name == "Session");
        var before = typeof(CelesteLoader).GetMethod(nameof(SlimBeforeLoad), BindingFlags.Static | BindingFlags.NonPublic);
        var body = Expression.Call(before, Expression.Convert(session, typeof(object)));
        ev.AddEventHandler(null, Expression.Lambda(handlerType, body, ps).Compile());
        slimInstalled = true;
        Console.WriteLine("[slim] watching levels being entered");
        return true;
    }

    static void SlimBeforeLoad(object session)
    {
        if (!slimOn) return;
        try
        {
            var (sid, map) = SessionMap(session);
            var clock = Stopwatch.StartNew();
            int n = SlimEnsure(Target(sid), map);
            if (n > 0) Console.WriteLine($"[slim] {sid}: group {slimGroup ?? "none"}, {n} maps changed in {clock.ElapsedMilliseconds} ms");
        }
        catch (Exception e)
        {
            Console.WriteLine("[slim] before load failed: " + (e.InnerException ?? e).Message);
        }
    }

    static (string sid, object map) SessionMap(object session)
    {
        var area = session.GetType().GetField("Area")?.GetValue(session);
        var areaData = celeste.GetType("Celeste.AreaData");
        var get = areaData.GetMethod("Get", BindingFlags.Static | BindingFlags.Public, null, new[] { area.GetType() }, null);
        var ad = get.Invoke(null, new[] { area });
        int mode = Convert.ToInt32(area.GetType().GetField("Mode").GetValue(area));
        var modes = (Array)F(ad, "Mode").GetValue(ad);
        var mp = modes.GetValue(mode);
        return (SidOf(ad), F(mp, "MapData")?.GetValue(mp));
    }

    static string SidOf(object ad)
    {
        var t = ad.GetType();
        return (t.GetProperty("SID")?.GetValue(ad) ?? t.GetField("SID")?.GetValue(ad)) as string;
    }

    // null = never touched (vanilla, lobbies, gyms)
    static string GroupOf(string sid)
    {
        if (sid == null || !sid.Contains('/')) return null;
        var p = sid.Split('/');
        if (p.Length >= 3 && (p[1] == "0-Lobbies" || p[1] == "0-Gyms")) return null;
        return string.Join("/", p, 0, p.Length - 1);
    }

    // the group a level asks for: a lobby asks for its folder, a map for its own
    static string Target(string sid)
    {
        if (sid == null || !sid.Contains('/')) return null;
        var p = sid.Split('/');
        if (p.Length >= 3 && p[1] == "0-Lobbies") return p[0] + "/" + p[2];
        return GroupOf(sid);
    }

    // keep `target` (and the map about to be played) complete, drop the rest
    static int SlimEnsure(string target, object playing)
    {
        if (target == null && slimGroup != null && playing != null) target = slimGroup; // vanilla or gym: change nothing
        int changed = 0;
        var areas = (IList)celeste.GetType("Celeste.AreaData").GetField("Areas", BindingFlags.Static | BindingFlags.Public).GetValue(null);
        foreach (var ad in areas)
        {
            if (ad == null) continue;
            var group = GroupOf(SidOf(ad));
            if (group == null) continue;
            var modes = F(ad, "Mode")?.GetValue(ad) as Array;
            if (modes == null) continue;
            foreach (var mp in modes)
            {
                if (mp == null) continue;
                var map = F(mp, "MapData")?.GetValue(mp);
                if (map == null) continue;
                bool keep = group == target || ReferenceEquals(map, playing);
                bool stripped = slimStripped.Contains(map);
                if (keep && stripped) { Reload(map); changed++; }
                else if (!keep && !stripped) { Strip(map); changed++; }
            }
        }
        slimGroup = target;
        return changed;
    }

    static void Strip(object map)
    {
        if (F(map, "Levels")?.GetValue(map) is not IList levels) return;
        foreach (var level in levels)
        {
            if (level == null) continue;
            foreach (var name in SlimTexts)
            {
                var f = F(level, name);
                if (f != null && f.FieldType == typeof(string)) f.SetValue(level, "");
            }
            foreach (var name in SlimLists)
            {
                var f = F(level, name);
                if (f != null && typeof(IList).IsAssignableFrom(f.FieldType) && f.GetValue(level) is IList old && old.Count > 0)
                    f.SetValue(level, Activator.CreateInstance(f.FieldType));
            }
        }
        slimStripped.Add(map);
    }

    static void Reload(object map)
    {
        map.GetType().GetMethod("Reload", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null).Invoke(map, null);
        slimStripped.Remove(map);
    }

    // Test links only (the page checks): start a level by its map name, with a
    // throwaway file if none is open. Used by the automatic browser test.
    [JSExport]
    internal static Task<string> TestLoad(string sid) => Task.FromResult(TestLoadNow(sid));

    static string TestLoadNow(string sid)
    {
        try
        {
            var scene = celeste.GetType("Monocle.Engine").GetProperty("Scene", BindingFlags.Static | BindingFlags.Public).GetValue(null);
            OnGameThread(scene, () =>
            {
                string step = "start";
                try
                {
                    step = "save";
                    var saveT = celeste.GetType("Celeste.SaveData");
                    if (saveT.GetField("Instance", BindingFlags.Static | BindingFlags.Public).GetValue(null) == null)
                    {
                        var data = Activator.CreateInstance(saveT);
                        saveT.GetField("Name")?.SetValue(data, "test");
                        var start = saveT.GetMethods(BindingFlags.Static | BindingFlags.Public).First(m => m.Name == "Start" && m.GetParameters().Length == 2);
                        start.Invoke(null, new[] { data, (object)0 });
                        saveT.GetMethod("AfterInitialize", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null)?.Invoke(data, null);
                    }
                    step = "area";
                    var areaData = celeste.GetType("Celeste.AreaData");
                    var ad = areaData.GetMethod("Get", BindingFlags.Static | BindingFlags.Public, null, new[] { typeof(string) }, null).Invoke(null, new object[] { sid });
                    if (ad == null) { Console.WriteLine("[test] no map " + sid); return; }
                    step = "key";
                    var toKey = areaData.GetMethod("ToKey", BindingFlags.Instance | BindingFlags.Public);
                    var key = toKey.Invoke(ad, toKey.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
                    step = "session";
                    var sessionT = celeste.GetType("Celeste.Session");
                    var ctor = sessionT.GetConstructors().OrderBy(c => c.GetParameters().Length).First(c => c.GetParameters().Length >= 1 && c.GetParameters()[0].ParameterType == key.GetType());
                    var args = ctor.GetParameters().Select((p, i) => i == 0 ? key : (p.HasDefaultValue ? p.DefaultValue : null)).ToArray();
                    var session = ctor.Invoke(args);
                    step = "go";
                    var go = celeste.GetType("Celeste.LevelEnter").GetMethod("Go", BindingFlags.Static | BindingFlags.Public);
                    go.Invoke(null, new object[] { session, false });
                    Console.WriteLine("[test] entering " + sid);
                }
                catch (Exception e) { Console.WriteLine("[test] load failed at " + step + ": " + (e.InnerException ?? e).ToString().Replace("\n", " | ")); }
            });
            return "ok";
        }
        catch (Exception e) { return "error: " + e.Message; }
    }

    // Test links only: what every Strawberry Jam / D-Sides map's summary says,
    // to check that dropping rooms leaves the counts alone.
    [JSExport]
    internal static Task<string> TestSummary() => Task.FromResult(TestSummaryNow());

    static string TestSummaryNow()
    {
        var sb = new System.Text.StringBuilder();
        try
        {
            var areas = (IList)celeste.GetType("Celeste.AreaData").GetField("Areas", BindingFlags.Static | BindingFlags.Public).GetValue(null);
            foreach (var ad in areas)
            {
                var sid = ad == null ? null : SidOf(ad);
                if (GroupOf(sid) == null && Target(sid) == null) continue;
                var modes = F(ad, "Mode")?.GetValue(ad) as Array;
                if (modes == null) continue;
                for (int m = 0; m < modes.Length; m++)
                {
                    var mp = modes.GetValue(m);
                    if (mp == null) continue;
                    var map = F(mp, "MapData")?.GetValue(mp);
                    int Count(object o, string f) => (F(o, f)?.GetValue(o) as ICollection)?.Count ?? -1;
                    int total = Convert.ToInt32(F(mp, "TotalStrawberries")?.GetValue(mp) ?? -1);
                    int cps = (F(mp, "Checkpoints")?.GetValue(mp) as Array)?.Length ?? -1;
                    int ents = 0;
                    if (map != null && F(map, "Levels")?.GetValue(map) is IList lv) foreach (var l in lv) ents += Count(l, "Entities");
                    sb.Append($"{sid}|{m}|berries {total}|map berries {(map == null ? -1 : Count(map, "Strawberries"))}|goldens {(map == null ? -1 : Count(map, "Goldenberries"))}|checkpoints {cps}|rooms {(map == null ? -1 : Count(map, "Levels"))}|room objects {ents}|{(map != null && slimStripped.Contains(map) ? "dropped" : "full")}\n");
                }
            }
        }
        catch (Exception e) { sb.Append("error: " + e.Message); }
        return sb.ToString();
    }
}
