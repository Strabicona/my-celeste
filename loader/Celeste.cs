using System;
using System.Threading;
using System.Threading.Tasks;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.InteropServices;
using System.IO;
using System.Reflection;
using System.Runtime.Loader;
using Microsoft.Xna.Framework;
using MonoMod.Core.Platforms;
using MonoMod.Logs;

[assembly: System.Runtime.Versioning.SupportedOSPlatform("browser")]

public static partial class CelesteLoader
{
    private static void Main()
    {
        Console.WriteLine(":3");
    }

    [DllImport("Emscripten")]
    public extern static void wasm_func_viil(Int32 x, Int32 y, Int64 l);

	[JSImport("XXHash64_Fast", "interop.js")]
	public static partial Task<JSObject> XXHash64_Fast(string file);

    internal static void CallPinvokeFixers()
    {
        wasm_func_viil(0, 0, 0);
        MonoMod.CustomBankLoader.PinvokeFix();
    }

    [JSExport]
    internal static Task PreInit()
    {
        return Task.Run(() =>
        {
            try
            {
                CallPinvokeFixers();

                Environment.SetEnvironmentVariable("FNA_PLATFORM_BACKEND", "SDL3");
                Environment.SetEnvironmentVariable("MONOMOD_DEPENDENCY_REMOVE_PATCH", "0");
                Environment.SetEnvironmentVariable("MONOMOD_WASM_ENABLE_MAGIC_OVERWRITE", "0");
            }
            catch (Exception e)
            {
                Console.Error.WriteLine("Error in PreInit()!");
                Console.Error.WriteLine(e);
                throw;
            }
        });
    }

    static Game game;
    static Assembly celeste;
    static FieldInfo RunApplication;

    [JSExport]
    internal static Task Init(bool tailcalls)
    {
        try
        {
            // Subscribe to Warning and Error logs from MonoMod
            DebugLog.Subscribe(LogLevelFilter.Warning | LogLevelFilter.Error, (source, time, level, msg) =>
            {
                Console.WriteLine($"[{source}] {level}: {msg}");
            });

            File.CreateSymbolicLink("/bin/Celeste.exe", "/libsdl/CustomCeleste.dll");
            File.CreateSymbolicLink("/bin/Celeste.dll", "/libsdl/CustomCeleste.dll");
            if (Directory.Exists("/libsdl/Celeste/Everest"))
            {
                File.CreateSymbolicLink("/bin/Celeste.Mod.mm.dll", "/libsdl/Celeste.Mod.mm.dll");
                File.CreateSymbolicLink("/bin/MMHOOK_Celeste.dll", "/libsdl/MMHOOK_Celeste.dll");

                File.Copy("/libsdl/Celeste/Everest/Celeste.Mod.mm.dll", "/libsdl/Celeste.Mod.mm.dll", true);
                File.Copy("/libsdl/Celeste/Everest/MMHOOK_Celeste.dll", "/libsdl/MMHOOK_Celeste.dll", true);
            }

            celeste = Assembly.LoadFrom("/libsdl/CustomCeleste.dll");

            WasmDetourFactory.EnableTailCallDetours = tailcalls;
            WasmDetourFactory.Blacklist.Add("System.Private.CoreLib");
            WasmDetourFactory.Blacklist.Add("System.Collections");
            WasmDetourFactory.Blacklist.Add("System.Collections.Concurrent");
            WasmDetourFactory.Blacklist.Add("System.IO.Compression");
            WasmDetourFactory.Blacklist.Add("System.IO.Compression.FileSystem");
            WasmDetourFactory.Blacklist.Add("System.IO.Compression.ZipFile");
            WasmDetourFactory.Blacklist.Add("System.IO.Hashing");
            WasmDetourFactory.Blacklist.Add("mscorlib");
            WasmDetourFactory.Blacklist.Add("netstandard");
            WasmDetourFactory.Blacklist.Add("FNA");
            WasmDetourFactory.Blacklist.Add("Mono.Cecil");
            WasmDetourFactory.Blacklist.Add("Mono.Cecil.Mdb");
            WasmDetourFactory.Blacklist.Add("Mono.Cecil.Pdb");
            WasmDetourFactory.Blacklist.Add("Mono.Cecil.Rocks");
            WasmDetourFactory.Blacklist.Add("MonoMod.Core");
            WasmDetourFactory.Blacklist.Add("MonoMod.Patcher");
            WasmDetourFactory.Blacklist.Add("MonoMod.ILHelpers");
            WasmDetourFactory.Blacklist.Add("MonoMod.RuntimeDetour");
            WasmDetourFactory.Blacklist.Add("MonoMod.RuntimeDetour.HookGen");

            AssemblyLoadContext.Default.ResolvingUnmanagedDll += (assembly, name) =>
            {
                if (name == "SDL2") name = "SDL3";
                return NativeLibrary.Load(name, assembly, null);
            };
            AssemblyLoadContext.Default.Resolving += (ctx, name) =>
            {
                try
                {
                    Assembly asm;
                    if (name.Name == "Celeste") asm = ctx.LoadFromAssemblyPath($"/libsdl/CustomCeleste.dll");
                    else if (name.Name == "Celeste.Mod.mm") asm = ctx.LoadFromAssemblyPath($"/libsdl/Celeste.Mod.mm.dll");
                    else asm = ctx.LoadFromAssemblyPath($"/libsdl/Celeste/Everest/{name.Name}.dll");
                    return asm;
                }
                catch
                {
                    return null;
                }
            };

            JsSplash.Init(celeste);

            var Celeste = celeste.GetType("Celeste.Celeste");
            var Settings = celeste.GetType("Celeste.Settings");
            var Engine = celeste.GetType("Monocle.Engine");

            var MainThreadId = Celeste.GetField("_mainThreadId", BindingFlags.Static | BindingFlags.NonPublic);
            var AssemblyDirectory = Engine.GetField("AssemblyDirectory", BindingFlags.Static | BindingFlags.NonPublic);
            var SettingsInitialize = Settings.GetMethod("Initialize", BindingFlags.Static | BindingFlags.Public);
            var GameConstructor = Celeste.GetConstructor([]);

            MainThreadId.SetValue(null, Thread.CurrentThread.ManagedThreadId);
            AssemblyDirectory.SetValue(null, "/");

            SettingsInitialize.Invoke(null, []);

            var Everest = celeste.GetType("Celeste.Mod.Everest");
            if (Everest != null)
            {
                var ParseArgs = Everest.GetMethod("ParseArgs", BindingFlags.Static | BindingFlags.NonPublic);
                ParseArgs.Invoke(null, [new string[] { }]);

				var XXH64_Fast = Everest.GetField("CelesteWasm_XXHash64Fast", BindingFlags.Static | BindingFlags.Public);
				if (XXH64_Fast != null) {
					Func<string, byte[]> XXH64 = (path) => {
						try {
							var ret = XXHash64_Fast(path).Result;
							return ret.GetPropertyAsByteArray("ret");
						} catch {
							return null;
						}
					};
					XXH64_Fast.SetValue(null, XXH64);
				}
            }

            Console.WriteLine($"CelesteWasm on {RuntimeInformation.FrameworkDescription}");
            game = (Game)GameConstructor.Invoke([]);
            RunApplication = Celeste.GetField("RunApplication", BindingFlags.NonPublic | BindingFlags.Instance);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("Error in Init()!");
            Console.Error.WriteLine(e);
            return Task.FromException(e);
        }
        return Task.Delay(0);
    }

    [JSExport]
    internal static Task Cleanup()
    {
        try
        {
            celeste.GetType("Celeste.RunThread").GetMethod("WaitAll").Invoke(null, []);
            celeste.GetType("Celeste.Audio").GetMethod("Unload").Invoke(null, []);
            game.Dispose();
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("Error in Cleanup()!");
            Console.Error.WriteLine(e);
            return Task.FromException(e);
        }
        return Task.Delay(0);
    }

    [JSExport]
    internal static Task<bool> RunOneFrame()
    {
        try
        {
            game.RunOneFrame();
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("Error in RunOneFrame()!");
            Console.Error.WriteLine(e);
            return (Task<bool>)Task.FromException(e);
        }
        return Task.FromResult((bool)RunApplication.GetValue(game));
    }

    [JSExport]
    internal static Task MainLoop()
    {
        try
        {
            game.Run();
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("Error in MainLoop()!");
            Console.Error.WriteLine(e);
            return Task.FromException(e);
        }
        return Task.Delay(0);
    }

    // Reports the game's own frames-per-second count (Monocle.Engine.FPS) twice a
    // second, for the FPS counter on the page. Only reads it; the game is untouched.
    [JSExport]
    internal static Task WatchFps([JSMarshalAs<JSType.Function<JSType.Number, JSType.Boolean>>] Func<double, bool> callback)
    {
        return Task.Run(async () =>
        {
            FieldInfo fps = null;
            while (true)
            {
                try
                {
                    if (fps == null && celeste != null)
                        fps = celeste.GetType("Monocle.Engine")?.GetField("FPS", BindingFlags.Static | BindingFlags.Public);
                }
                catch { }
                double value = fps != null ? (int)fps.GetValue(null) : -1;
                if (callback(value)) break;
                await Task.Delay(500);
            }
        });
    }

    // The real frame counter (10 Nov 2026). The game's own FPS number is an
    // average over a whole second, so a freeze of a fifth of a second barely
    // moves it. This watches the engine's draw counter (Engine.fpsCounter, which
    // changes on every drawn frame, also during the short freeze on a dash)
    // every 2 ms and times the gap between frames, so a stall shows as one long
    // frame. Four times a second it reports "frames in the last second|longest
    // frame in the last second (ms)". A memory clean-up stops this watcher too;
    // the gap it leaves is still counted.
    [JSExport]
    internal static Task WatchFrames([JSMarshalAs<JSType.Function<JSType.String, JSType.Boolean>>] Func<string, bool> callback)
    {
        return Task.Run(async () =>
        {
            Func<object> instance = null;
            FieldInfo counter = null;
            bool told = false;
            int lastValue = int.MinValue;
            var clock = System.Diagnostics.Stopwatch.StartNew();
            var frames = new System.Collections.Generic.Queue<(double at, double gap)>();
            double lastFrameAt = 0, nextReport = 250;
            while (true)
            {
                double now = clock.Elapsed.TotalMilliseconds;
                try
                {
                    if (counter == null && celeste != null)
                    {
                        var engine = celeste.GetType("Monocle.Engine");
                        var all = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
                        var ip = engine?.GetProperty("Instance", all);
                        var iff = ip == null ? engine?.GetField("Instance", all) : null;
                        if (ip != null) instance = () => ip.GetValue(null);
                        else if (iff != null) instance = () => iff.GetValue(null);
                        counter = engine?.GetField("fpsCounter", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                        if (!told && engine != null)
                        {
                            told = true;
                            bool ok = counter != null && instance != null;
                            Console.WriteLine("[frames] draw counter " + (ok ? "found" : "missing, using the game's FPS number"));
                            if (!ok)
                            {
                                callback("missing");
                                break;
                            }
                        }
                    }
                    var inst = instance?.Invoke();
                    if (inst != null && counter != null)
                    {
                        int value = (int)counter.GetValue(inst);
                        if (lastValue == int.MinValue) lastFrameAt = now;
                        else if (value != lastValue)
                        {
                            frames.Enqueue((now, now - lastFrameAt));
                            lastFrameAt = now;
                        }
                        lastValue = value;
                    }
                }
                catch { }
                while (frames.Count > 0 && frames.Peek().at < now - 1000) frames.Dequeue();
                if (now >= nextReport)
                {
                    nextReport = now + 250;
                    double worst = lastValue == int.MinValue ? 0 : now - lastFrameAt; // a frame still not done counts too
                    foreach (var f in frames) if (f.gap > worst) worst = f.gap;
                    if (callback(frames.Count + "|" + (int)worst)) break;
                }
                await Task.Delay(2);
            }
        });
    }

    // Once a second: what the game is doing, for auto-pause and the health report
    // (added 8-9 Nov 2026). Only reads; never changes the game.
    // "state|gen0|gen1|gen2|gcPauseMs|managedMB"; state: 0 not in a level,
    // 1 in a level and running, 2 in a level and paused
    // Away freeze (10 Nov 2026): Celeste's file clock keeps counting in the pause
    // menu. While the page says you are away and the level is paused, the file
    // time, the chapter's time played and the run time are held at the value they
    // had when the freeze began. Gameplay itself is untouched.
    static volatile bool away;
    [JSExport]
    internal static Task SetAway(bool value)
    {
        away = value;
        return Task.CompletedTask;
    }

    sealed class Frozen
    {
        public object Save, Session, Mode;
        public long SaveTime, SessionTime, ModeTime;
    }

    static FieldInfo F(object o, string name) =>
        o?.GetType().GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);

    static Frozen FreezeStart(object level)
    {
        // each part on its own: a part that fails never stops the others
        var fr = new Frozen();
        try
        {
            fr.Save = celeste.GetType("Celeste.SaveData")?.GetField("Instance", BindingFlags.Static | BindingFlags.Public)?.GetValue(null);
            if (fr.Save != null) fr.SaveTime = (long)F(fr.Save, "Time").GetValue(fr.Save);
        }
        catch (Exception e) { fr.Save = null; Console.WriteLine("[away] file time not held: " + e.Message); }
        try
        {
            fr.Session = F(level, "Session")?.GetValue(level);
            if (fr.Session != null) fr.SessionTime = (long)F(fr.Session, "Time").GetValue(fr.Session);
        }
        catch (Exception e) { fr.Session = null; Console.WriteLine("[away] run time not held: " + e.Message); }
        try
        {
            var key = F(fr.Session, "Area").GetValue(fr.Session);
            var getFor = fr.Save.GetType().GetMethod("GetAreaStatsFor", BindingFlags.Instance | BindingFlags.Public);
            var stats = getFor?.Invoke(fr.Save, [key]);
            if (stats != null)
            {
                int mode = Convert.ToInt32(F(key, "Mode").GetValue(key));
                var modes = (Array)F(stats, "Modes").GetValue(stats);
                fr.Mode = modes.GetValue(mode);
                fr.ModeTime = (long)F(fr.Mode, "TimePlayed").GetValue(fr.Mode);
            }
        }
        catch (Exception e) { fr.Mode = null; Console.WriteLine("[away] chapter time not held: " + e.Message); }
        Console.WriteLine($"[away] clock frozen (file {(fr.Save != null ? "yes" : "no")}, run {(fr.Session != null ? "yes" : "no")}, chapter {(fr.Mode != null ? "yes" : "no")})");
        return fr;
    }

    static void FreezeHold(Frozen fr)
    {
        try { if (fr.Save != null) F(fr.Save, "Time").SetValue(fr.Save, fr.SaveTime); } catch { }
        try { if (fr.Session != null) F(fr.Session, "Time").SetValue(fr.Session, fr.SessionTime); } catch { }
        try { if (fr.Mode != null) F(fr.Mode, "TimePlayed").SetValue(fr.Mode, fr.ModeTime); } catch { }
    }

    [JSExport]
    internal static Task WatchScene([JSMarshalAs<JSType.Function<JSType.String, JSType.Boolean>>] Func<string, bool> callback)
    {
        return Task.Run(async () =>
        {
            PropertyInfo sceneProp = null;
            PropertyInfo savingProp = null;
            Frozen frozen = null;
            object frozenLevel = null;
            while (true)
            {
                int state = 0;
                try
                {
                    if (sceneProp == null && celeste != null)
                        sceneProp = celeste.GetType("Monocle.Engine")?.GetProperty("Scene", BindingFlags.Static | BindingFlags.Public);
                    var scene = sceneProp?.GetValue(null);
                    if (scene != null && scene.GetType().FullName == "Celeste.Level")
                    {
                        var paused = scene.GetType().GetField("Paused", BindingFlags.Instance | BindingFlags.Public);
                        state = paused != null && (bool)paused.GetValue(scene) ? 2 : 1;
                    }
                    if (away && state == 2)
                    {
                        if (frozen == null || frozenLevel != scene)
                        {
                            frozen = FreezeStart(scene);
                            frozenLevel = scene;
                        }
                        else FreezeHold(frozen);
                    }
                    else if (frozen != null)
                    {
                        FreezeHold(frozen); // one last time, then let it run
                        frozen = null;
                        frozenLevel = null;
                        Console.WriteLine("[away] clock running again");
                    }
                }
                catch { }
                int saving = 0;
                try
                {
                    if (savingProp == null && celeste != null)
                        savingProp = celeste.GetType("Celeste.UserIO")?.GetProperty("Saving", BindingFlags.Static | BindingFlags.Public);
                    if (savingProp != null && (bool)savingProp.GetValue(null)) saving = 1;
                }
                catch { }
                string info = state + "|" + GC.CollectionCount(0) + "|" + GC.CollectionCount(1) + "|" + GC.CollectionCount(2)
                    + "|" + (long)GC.GetTotalPauseDuration().TotalMilliseconds
                    + "|" + (GC.GetTotalMemory(false) / (1024 * 1024))
                    + "|" + saving;
                if (callback(info)) break;
                await Task.Delay(frozen != null ? 50 : 250);
            }
        });
    }

    // Save & Quit, as the pause menu does it: inside a level the game leaves
    // through LevelExit(SaveAndQuit), which writes the file with the current
    // checkpoint; anywhere else the file is already saved.
    [JSExport]
    internal static Task<string> SaveAndQuit()
    {
        return Task.FromResult(SaveAndQuitNow());
    }

    static string SaveAndQuitNow()
    {
        try
        {
            var sceneProp = celeste.GetType("Monocle.Engine").GetProperty("Scene", BindingFlags.Static | BindingFlags.Public);
            var scene = sceneProp.GetValue(null);
            if (scene == null || scene.GetType().FullName != "Celeste.Level") return "menu";
            object Member(string name)
            {
                var t = scene.GetType();
                var f = t.GetField(name, BindingFlags.Instance | BindingFlags.Public);
                if (f != null) return f.GetValue(scene);
                return t.GetProperty(name, BindingFlags.Instance | BindingFlags.Public)?.GetValue(scene);
            }
            var session = Member("Session");
            var snow = Member("HiresSnow");
            var exitType = celeste.GetType("Celeste.LevelExit");
            var modeType = celeste.GetType("Celeste.LevelExit+Mode");
            var mode = Enum.Parse(modeType, "SaveAndQuit");
            var exit = Activator.CreateInstance(exitType, mode, session, snow);
            sceneProp.SetValue(null, exit);
            Console.WriteLine("[relaunch] save and quit started");
            return "level";
        }
        catch (Exception e)
        {
            return "error: " + e.Message;
        }
    }

    [JSExport]
    internal static Task WatchMemoryUsage([JSMarshalAs<JSType.Function<JSType.Number, JSType.Boolean>>] Func<double, bool> callback)
    {
        return Task.Run(async () =>
        {
            while (true)
            {
                bool stop = callback((double)GC.GetTotalMemory(false) / (1024 * 1024));
				if (stop) break;
                await Task.Delay(1000 * 30);
            }
        });
    }
}
