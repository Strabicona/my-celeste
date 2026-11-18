using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.InteropServices.JavaScript;
using System.Threading.Tasks;

// Memory clean-ups only at breaks (asked 18 Nov 2026).
//
// The game's full memory clean-up freezes it for 120-220 ms. With the default
// settings it ran 2-8 times a minute in the middle of play. Now the runtime is
// started with a lot more room (see GC_BIG in frontend/src/game/dotnet.ts), so
// its own clean-up only comes when the memory is nearly full, and this file
// runs the clean-up itself at a break, once enough has piled up:
//  - death or room change: when the memory is at `dueMB` or more
//  - pause (also the idle pause), entering or leaving a level: at `pauseMB`
// If nothing breaks before the room runs out, the runtime's own clean-up still
// runs then (it would run out of memory otherwise): that is the safety margin.
//
// Every minute it reports how much piled up, so the numbers can be checked.
//
// Found by the test on 18 Nov: Celeste itself runs a full clean-up at EVERY
// death (Level.Reload) and EVERY room change (the transition routine). On a PC
// that takes ~10 ms; here 120-220 ms, which is the hitch felt at each death and
// room change. Those calls are now sent to GameWantsCleanup, which only cleans
// up when enough has piled up (death/room change threshold).
public static partial class CelesteLoader
{
    static long breakDueMB = 700, breakPauseMB = 450;
    static bool breaksOn, breaksInstalled;
    static int ourCleanups, deaths, rooms;
    static long longestCleanupMs;

    [JSExport]
    internal static Task<string> StartBreaks(bool on, int dueMB, int pauseMB)
    {
        breaksOn = on;
        breakDueMB = dueMB;
        breakPauseMB = pauseMB;
        string hooks = "";
        if (!breaksInstalled)
        {
            breaksInstalled = true;
            hooks = string.Join(", ", new[] {
                HookBreak("Celeste.Mod.Everest+Events+Player", "OnDie", "death"),
                HookBreak("Celeste.Mod.Everest+Events+Level", "OnTransitionTo", "room"),
                HookBreak("Celeste.Mod.Everest+Events+Level", "OnPause", "pause"),
                HookBreak("Celeste.Mod.Everest+Events+Level", "OnEnter", "level start"),
                HookBreak("Celeste.Mod.Everest+Events+Level", "OnExit", "level end"),
            });
            hooks += "; " + SkipGameCleanups();
            WatchPileUp();
        }
        return Task.FromResult(on
            ? $"on: clean-ups at deaths/room changes from {dueMB} MB, at pauses from {pauseMB} MB ({hooks})"
            : $"off, only measuring ({hooks})");
    }

    static string HookBreak(string type, string name, string why)
    {
        try
        {
            var ev = celeste.GetType(type)?.GetEvent(name, BindingFlags.Static | BindingFlags.Public);
            if (ev == null) return why + " missing";
            var ps = ev.EventHandlerType.GetMethod("Invoke").GetParameters().Select(p => Expression.Parameter(p.ParameterType, p.Name)).ToArray();
            var call = Expression.Call(typeof(CelesteLoader).GetMethod(nameof(AtBreak), BindingFlags.Static | BindingFlags.NonPublic), Expression.Constant(why));
            ev.AddEventHandler(null, Expression.Lambda(ev.EventHandlerType, call, ps).Compile());
            return why;
        }
        catch (Exception e) { return why + " failed: " + (e.InnerException ?? e).Message; }
    }

    // runs on the game's own thread, inside the death / room change / pause
    static void AtBreak(string why)
    {
        if (why == "death") deaths++;
        if (why == "room") rooms++;
        if (!breaksOn) return;
        try
        {
            long used = GC.GetTotalMemory(false) >> 20;
            long due = why == "death" || why == "room" ? breakDueMB : breakPauseMB;
            if (used < due) return;
            var clock = Stopwatch.StartNew();
            GC.Collect();
            ourCleanups++;
            long ms = clock.ElapsedMilliseconds;
            if (ms > longestCleanupMs) longestCleanupMs = ms;
            Console.WriteLine($"[gc] clean-up at {why}: {used} -> {GC.GetTotalMemory(false) >> 20} MB in {ms} ms");
        }
        catch (Exception e) { Console.WriteLine("[gc] clean-up failed: " + e.Message); }
    }

    static readonly List<object> gcHooks = new();
    static int gameAsked, gameSkipped;

    // the game's own "clean up now" at deaths and room changes
    public static void GameWantsCleanup()
    {
        gameAsked++;
        if (!breaksOn) { GC.Collect(); return; }
        long used = GC.GetTotalMemory(false) >> 20;
        if (used < breakDueMB) { gameSkipped++; return; }
        var clock = Stopwatch.StartNew();
        GC.Collect();
        ourCleanups++;
        long ms = clock.ElapsedMilliseconds;
        if (ms > longestCleanupMs) longestCleanupMs = ms;
        Console.WriteLine($"[gc] clean-up asked by the game: {used} -> {GC.GetTotalMemory(false) >> 20} MB in {ms} ms");
    }

    static Type FindType(string name) =>
        AppDomain.CurrentDomain.GetAssemblies().Select(a => { try { return a.GetType(name); } catch { return null; } }).FirstOrDefault(t => t != null);

    // send Celeste's GC.Collect() calls in the level (Reload = death, the
    // transition routine = room change) to GameWantsCleanup
    static string SkipGameCleanups()
    {
        try
        {
            var hookT = FindType("MonoMod.RuntimeDetour.ILHook");
            var ctxT = FindType("MonoMod.Cil.ILContext");
            var manipT = ctxT?.GetNestedType("Manipulator");
            if (hookT == null || manipT == null) return "game clean-ups: no ILHook";
            var levelT = celeste.GetType("Celeste.Level");
            var targets = new List<MethodBase>();
            var reload = levelT.GetMethod("Reload", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
            if (reload != null) targets.Add(reload);
            foreach (var nt in levelT.GetNestedTypes(BindingFlags.NonPublic | BindingFlags.Public))
                if (nt.Name.Contains("TransitionRoutine"))
                {
                    var mn = nt.GetMethod("MoveNext", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                    if (mn != null) targets.Add(mn);
                }
            var p = Expression.Parameter(ctxT, "il");
            var manip = Expression.Lambda(manipT, Expression.Call(typeof(CelesteLoader).GetMethod(nameof(RedirectCollect), BindingFlags.Static | BindingFlags.NonPublic), Expression.Convert(p, typeof(object))), p).Compile();
            var done = new List<string>();
            foreach (var m in targets)
            {
                redirected = 0;
                try
                {
                    gcHooks.Add(Activator.CreateInstance(hookT, m, manip));
                    done.Add($"{m.DeclaringType.Name}.{m.Name}: {redirected}");
                }
                catch (Exception e) { done.Add($"{m.Name} failed: {(e.InnerException ?? e).Message}"); }
            }
            return "game clean-ups redirected: " + string.Join(", ", done);
        }
        catch (Exception e) { return "game clean-ups: failed " + (e.InnerException ?? e).Message; }
    }

    static int redirected;
    static void RedirectCollect(object il)
    {
        var instrs = (IEnumerable)il.GetType().GetProperty("Instrs").GetValue(il);
        object target = null;
        foreach (var ins in instrs)
        {
            var opProp = ins.GetType().GetProperty("Operand");
            var op = opProp.GetValue(ins);
            if (op == null) continue;
            var full = op.GetType().GetProperty("FullName")?.GetValue(op) as string;
            if (full != "System.Void System.GC::Collect()" && full != "System.Void Celeste.Level::_GCCollect()") continue;
            target ??= ImportInto(il, typeof(CelesteLoader).GetMethod(nameof(GameWantsCleanup), BindingFlags.Static | BindingFlags.Public));
            opProp.SetValue(ins, target);
            redirected++;
        }
    }

    static object ImportInto(object il, MethodBase m)
    {
        var imp = il.GetType().GetMethod("Import", new[] { typeof(MethodBase) });
        if (imp != null) return imp.Invoke(il, new object[] { m });
        var module = il.GetType().GetProperty("Module").GetValue(il);
        return module.GetType().GetMethod("ImportReference", new[] { typeof(MethodBase) }).Invoke(module, new object[] { m });
    }

    // once a minute: how much piled up, and how many clean-ups ran where
    static void WatchPileUp()
    {
        Task.Run(async () =>
        {
            long lastAlloc = GC.GetTotalAllocatedBytes(false);
            int lastFull = GC.CollectionCount(2), lastOurs = 0, lastDeaths = 0, lastRooms = 0;
            long peak = 0;
            for (int tick = 1; ; tick++)
            {
                await Task.Delay(5000);
                long used = GC.GetTotalMemory(false) >> 20;
                if (used > peak) peak = used;
                if (tick % 12 != 0) continue;
                long alloc = GC.GetTotalAllocatedBytes(false);
                int full = GC.CollectionCount(2), ours = ourCleanups;
                int own = (full - lastFull) - (ours - lastOurs);
                int d = deaths - lastDeaths, r = rooms - lastRooms;
                long piled = (alloc - lastAlloc) >> 20;
                Console.WriteLine($"[gc] last minute: {piled} MB piled up, memory now {used} MB (highest {peak}), "
                    + $"clean-ups: {ours - lastOurs} at breaks (longest {longestCleanupMs} ms), {Math.Max(own, 0)} during play; "
                    + $"{d} deaths, {r} room changes, game asked {gameAsked} (skipped {gameSkipped})"
                    + (d + r > 0 ? $", about {piled / (d + r)} MB each" : ""));
                lastAlloc = alloc; lastFull = full; lastOurs = ours; lastDeaths = deaths; lastRooms = rooms;
                peak = used; longestCleanupMs = 0; gameAsked = 0; gameSkipped = 0;
            }
        });
    }

    // test links: kill the player, to measure what a death piles up
    [JSExport]
    internal static Task<string> TestDie()
    {
        try
        {
            var scene = celeste.GetType("Monocle.Engine").GetProperty("Scene", BindingFlags.Static | BindingFlags.Public).GetValue(null);
            if (scene?.GetType().Name != "Level") return Task.FromResult("not in a level: " + scene?.GetType().Name);
            OnGameThread(scene, () =>
            {
                try
                {
                    var tracker = scene.GetType().GetProperty("Tracker").GetValue(scene);
                    var playerT = celeste.GetType("Celeste.Player");
                    var player = tracker.GetType().GetMethods().First(m => m.Name == "GetEntity" && m.IsGenericMethod).MakeGenericMethod(playerT).Invoke(tracker, null);
                    if (player == null) return;
                    var die = playerT.GetMethods().First(m => m.Name == "Die");
                    var vec = die.GetParameters()[0].ParameterType;
                    var args = die.GetParameters().Select((p, i) => i == 0 ? Activator.CreateInstance(vec) : i == 1 ? (object)true : (p.HasDefaultValue ? p.DefaultValue : null)).ToArray();
                    die.Invoke(player, args);
                }
                catch (Exception e) { Console.WriteLine("[test] die failed: " + (e.InnerException ?? e).Message); }
            });
            return Task.FromResult("ok");
        }
        catch (Exception e) { return Task.FromResult("failed: " + e.Message); }
    }
}
