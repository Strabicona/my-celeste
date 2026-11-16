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

    // Called once the engine has started. Waits for the title screen, then:
    //  - if Everest had to rewrite the mods' code this time (empty cache, the
    //    first start after a download), answers "restart": that first start
    //    keeps ~850 MB of working data alive for the whole session, while the
    //    next start reads the rewritten code from the cache (measured 16 Nov:
    //    1394 MB vs 551 MB). The page then restarts the game once.
    //  - otherwise, with `on`, drops the rooms of the maps not being played.
    [JSExport]
    internal static Task<string> StartSlimMaps(bool on, bool restartIfRelinked)
    {
        slimOn = on;
        var done = new TaskCompletionSource<string>();
        Task.Run(async () =>
        {
            for (int i = 0; i < 2400; i++)
            {
                try
                {
                    var scene = celeste?.GetType("Monocle.Engine")?.GetProperty("Scene", BindingFlags.Static | BindingFlags.Public)?.GetValue(null);
                    if (scene != null && scene.GetType().FullName != "Celeste.GameLoader")
                    {
                        OnGameThread(scene, () =>
                        {
                            try
                            {
                                if (restartIfRelinked && Relinked())
                                {
                                    slimOn = false;
                                    done.TrySetResult("restart: the mods' code was rewritten this start (" + GC.GetTotalMemory(false) / (1024 * 1024) + " MB)");
                                    return;
                                }
                                if (!slimOn) { done.TrySetResult("off, " + GC.GetTotalMemory(false) / (1024 * 1024) + " MB"); return; }
                                if (!InstallSlimHook()) { slimOn = false; done.TrySetResult("off: could not watch levels"); return; }
                                var clock = Stopwatch.StartNew();
                                var before = GC.GetTotalMemory(false) / (1024 * 1024);
                                int n = SlimEnsure(null, null);
                                var after = GC.GetTotalMemory(true) / (1024 * 1024);
                                done.TrySetResult($"on: dropped rooms of {n} maps in {clock.ElapsedMilliseconds} ms, memory {before} -> {after} MB");
                            }
                            catch (Exception e) { slimOn = false; done.TrySetResult("failed, off: " + (e.InnerException ?? e).Message); }
                        });
                        return;
                    }
                }
                catch { }
                await Task.Delay(500);
            }
            done.TrySetResult("title screen never came");
        });
        return done.Task;
    }

    // Everest keeps this filled only when it rewrote mod code during this start
    static bool Relinked()
    {
        var f = celeste.GetType("Celeste.Mod.Everest+Relinker")?.GetField("_SharedRelinkMap", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);
        return f?.GetValue(null) is ICollection c && c.Count > 0;
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
                    var keyT = celeste.GetType("Celeste.AreaKey");
                    int id = Convert.ToInt32(ad.GetType().GetProperty("ID")?.GetValue(ad) ?? F(ad, "ID").GetValue(ad));
                    var modeT = celeste.GetType("Celeste.AreaMode");
                    var key = Activator.CreateInstance(keyT, id, Enum.ToObject(modeT, 0));
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

    // Test links only: how much memory the maps hold in total. Drops every mod
    // map completely (not just its rooms), measures, and is NOT undone (the
    // test page is reloaded afterwards).
    [JSExport]
    internal static Task<string> TestDropAllMaps()
    {
        var done = new TaskCompletionSource<string>();
        var scene = celeste.GetType("Monocle.Engine").GetProperty("Scene", BindingFlags.Static | BindingFlags.Public).GetValue(null);
        OnGameThread(scene, () =>
        {
            try
            {
                long before = GC.GetTotalMemory(true) / (1024 * 1024);
                int n = 0;
                var areas = (IList)celeste.GetType("Celeste.AreaData").GetField("Areas", BindingFlags.Static | BindingFlags.Public).GetValue(null);
                foreach (var ad in areas)
                {
                    var sid = ad == null ? null : SidOf(ad);
                    if (sid == null || !sid.Contains('/')) continue;
                    if (F(ad, "Mode")?.GetValue(ad) is not Array modes) continue;
                    foreach (var mp in modes) { var f = mp == null ? null : F(mp, "MapData"); if (f?.GetValue(mp) != null) { f.SetValue(mp, null); n++; } }
                }
                long after = GC.GetTotalMemory(true) / (1024 * 1024);
                done.SetResult($"dropped {n} maps completely: {before} -> {after} MB");
            }
            catch (Exception e) { done.SetResult("error: " + e.Message); }
        });
        return done.Task;
    }

    // Test links only: list Everest's code-rewriter caches (Everest.Relinker's
    // static fields) and, with clear=true, empty them and measure memory.
    [JSExport]
    internal static Task<string> TestRelinker(bool clear)
    {
        var done = new TaskCompletionSource<string>();
        var scene = celeste.GetType("Monocle.Engine").GetProperty("Scene", BindingFlags.Static | BindingFlags.Public).GetValue(null);
        OnGameThread(scene, () =>
        {
            var sb = new System.Text.StringBuilder();
            try
            {
                var t = celeste.GetType("Celeste.Mod.Everest+Relinker");
                if (t == null) { done.SetResult("no Everest.Relinker"); return; }
                long before = GC.GetTotalMemory(true) / (1024 * 1024);
                foreach (var f in t.GetFields(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
                {
                    object v = null;
                    try { v = f.GetValue(null); } catch { }
                    string what = v == null ? "null" : v.GetType().Name + (v is ICollection c ? $"[{c.Count}]" : "");
                    sb.Append($"{f.Name}: {f.FieldType.Name} = {what}");
                    if (clear && v != null && !f.IsLiteral && !f.IsInitOnly && !f.FieldType.IsValueType && f.FieldType != typeof(string))
                    {
                        try
                        {
                            if (v is IDictionary d) foreach (var x in d.Values) (x as IDisposable)?.Dispose();
                            (v as IDisposable)?.Dispose();
                            f.SetValue(null, null);
                            sb.Append(" -> cleared");
                        }
                        catch (Exception e) { sb.Append(" -> " + e.Message); }
                    }
                    sb.Append("\n");
                }
                long after = GC.GetTotalMemory(true) / (1024 * 1024);
                sb.Append($"memory {before} -> {after} MB");
            }
            catch (Exception e) { sb.Append("error: " + e.Message); }
            done.SetResult(sb.ToString());
        });
        return done.Task;
    }
}
