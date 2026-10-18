# Porting Terraria and Celeste to WebAssembly

One of my favorite genres of weird project is "thing running in the browser that should absolutely not be running in the browser". Some of my favorites are the [Half Life 1 port](https://github.com/btarg/Xash3D-Emscripten) that uses a reimplementation of goldsrc, the [direct recompilation of Minecraft 1.12](https://eaglercraft.com) from java bytecode to WebAssembly, and even an [emulated Pentium 4 capable of running modern linux](https://copy.sh/v86/).

In early 2024 I came across an old post of someone running a half working copy of the game [Celeste](https://www.celestegame.com) entirely in the browser. When I saw that they had never posted their work publicly, I became about as obsessed with the idea as you would expect, leading to a year long journey of bytecode hacks, runtime bugs, patch files, and horrible build systems all to create something that really should have never existed.

thanks to [r58](https://www.r58playz.dev) for figuring most of this stuff out with me and [bomberfish](https://bomberfish.ca) for making a cool ui

# Terraria

I knew that both Celeste and Terraria were written in C# using the FNA engine, so it was seemingly possible to port Terraria too, and that's what we set out to do.

<!-- Celeste was written in C#, using XNA. Actually FNA.

XNA *was* a proprietary low level game "engine" developed and subsequently abandoned by Microsoft. It was eventually replaced with the community maintained FNA library, including a SDL backend and greater platform support.

Terraria was also built with XNA/FNA, so I assumed we co -->

The original post didn't have too many details to go off of, but we figured a good place to start was setting up a development environment for modding. In theory, all we needed to do was decompile the game, change the target to webassembly, and then recompile it.

It turns out that we were very lucky with the game being C#— since the bytecode format (referred to as MSIL or just IL) maps very closely to the original code, and the game was shipped with the .pdb symbol database for mapping function names (and local variables!), we could get decompilation output that was more or less identical to the original code.

## Setting up a project

<!-- Running `ilspycmd` on Terraria.exe, decompilation *failed* because of a missing `ReLogic.dll`. It turned out that the library was actually embedded into the game itself as a resource.

That's.. odd, but we can extract it from the binary pretty easily. Easiest way is just to create a new c# project and dynamically load in the assembly..

```cs
Assembly assembly = Assembly.LoadFile("Terraria.exe");
```
And then since all the terraria code is loaded, we can just extract it the same way the game does!
```cs
Stream? stream = assembly.GetManifestResourceStream("Terraria.Libraries.NET.ReLogic.dll");
FileStream outstream = File.OpenWrite("ReLogic.dll");
stream.CopyTo(outstream);
```

After putting `ReLogic.dll` into the library path, decompilation succeeded, and after installing all the dependencies Terraria uses, the project recompiles and launches on linux. -->

After extracting `ReLogic.dll` and putting it into the library path, decompilation succeeded, and after installing all the dependencies Terraria uses, the project recompiles and launches on linux.
Now that we knew the decompilation was good, I created a project file for the new code targetting WASM and configuring emscripten.

```xml
<Project Sdk="Microsoft.NET.Sdk.WebAssembly">
<PropertyGroup>
		<StartupObject>Program</StartupObject>
		<EmccExtraLDFlags>-sMIN_WEBGL_VERSION=2 -sWASMFS</EmccExtraLDFlags>
		<EmccEnvironment>web,worker</EmccEnvironment>
</PropertyGroup>
<ItemGroup>
		<PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
		<PackageReference Include="Newtonsoft.Json.Bson" Version="1.0.3" />
		<PackageReference Include="DotNetZip" Version="1.16.0" />
		<PackageReference Include="MP3Sharp" Version="1.0.5" />
		<PackageReference Include="NVorbis" Version="0.10.5" />
</ItemGroup>
</Project>
```

Somewhat surprisingly, all of the project code compiles without issue, but the FNA engine is partially written in c++ and needs to be linked against its native components. The web target isn't officially supported by FNA, but its native components compile without issue under emscripten's [opengl emulation layer](https://emscripten.org/docs/porting/multimedia_and_graphics/OpenGL-support.html#opengl-support-opengl-es2-0-emulation). This process is automated by [FNA-WASM-BUILD](https://github.com/r58Playz/FNA-WASM-Build) on github actions to make things slightly less painful.

The archive files from the build system can be added with `<NativeFileReference>` and then will automatically get linked together with the rest of the runtime during emscripten compilation.

```xml
<!-- FNA -->
<NativeFileReference Include="SDL3.a" />
<NativeFileReference Include="FNA3D.a" />
<NativeFileReference Include="libmojoshader.a" />
<NativeFileReference Include="FAudio.a" />
```

Now, it fully builds and generates web output, and we can try and get the game running.

## Running the game

Everything compiles, but for the game to actually launch we have to get the game assets into the environment, meaning we have another chance to use one of my favorite browser APIs, the [Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system). Since everything goes through emscripten's filesystem emulation, we can just ask the user to select their game directory with `window.showDirectoryPicker()`, then copy in the assets and mount it in the emscripten filesystem.

image here

After a [quick patch to FNA](https://github.com/MercuryWorkshop/terraria-wasm/blob/master/FNA.patch) to resolve a generics issue, the game launched.

![ReLogic Logo](assets/relogic-logo.png)

...and then immediately crashed after trying to create a new thread, which was not supported in .NET 8.0 wasm.

Fortunately we found a clever solution: waiting about a month for NET 9.0 to get a stable release. Once it was packaged, we acould just add the new `<WasmEnableThreads>true</WasmEnableThreads>` option to the project and recompiled.

This time though, FNA failed to initialize.

It turns out that in NET threaded mode, _all_ code runs inside web workers, not just the secondary threads. What would usually be called the "main" thread is actually running on `dotnet-worker-001`, referred to as the "deputy thread", which is created during dotnet initialization.

This is an issue since FNA is solely in the worker, and the `<canvas>` can only be accessed on the DOM thread. This is solved by the browser's `OffscreenCanvas` API, but we were still working with SDL2, which didn't support it, and FNA didn't work with SDL3 at the time we wrote this.

## FNA Proxy

If we couldn't run the game on the main thread, and we couldn't transfer the canvas over to the worker, the only option left was to proxy the OpenGL calls to the main thread.

We wrote a [fish script](https://github.com/r58Playz/FNA-WASM-Build/blob/b05cbc703753c917499bf955091f62c3b845ba8f/wrap_fna.fish) that would automatically parse every single method from FNA3D's exported symbols (FNA's native C component), and automatically compile and export a wrapper method that would use `emscripten_proxy_sync` to proxy the call from `dotnet-worker-001` to the DOM thread.

Let's look at the native method `FNA3D_Device* FNA3D_CreateDevice(FNA3D_PresentationParameters *presentationParameters,uint8_t debugMode);`, the first one that gets called in any program

The script automatically generates a C file containing the wrapper method, `WRAP_FNA3D_CreateDevice`

```c
typedef struct {
	FNA3D_PresentationParameters *presentationParameters;
	uint8_t debugMode;
	FNA3D_Device* *WRAP_RET;
} WRAP__struct_FNA3D_CreateDevice;
void WRAP__MAIN__FNA3D_CreateDevice(void *wrap_struct_ptr) {
	WRAP__struct_FNA3D_CreateDevice *wrap_struct = (WRAP__struct_FNA3D_CreateDevice*)wrap_struct_ptr;
	*(wrap_struct->WRAP_RET) = FNA3D_CreateDevice(
		wrap_struct->presentationParameters,
		wrap_struct->debugMode
	);
}
FNA3D_Device* WRAP_FNA3D_CreateDevice(FNA3D_PresentationParameters *presentationParameters,uint8_t debugMode)
{
	// $func: `FNA3D_Device* FNA3D_CreateDevice(FNA3D_PresentationParameters *presentationParameters,uint8_t debugMode)`
	// $ret: `FNA3D_Device*`
	// $name: `FNA3D_CreateDevice`
	// $args: `FNA3D_PresentationParameters *presentationParameters,uint8_t debugMode`
	// $argsargs: `presentationParameters,debugMode`
	// $argc: `2`
	//
	// return FNA3D_CreateDevice(presentationParameters,debugMode);
	FNA3D_Device* wrap_ret;
	WRAP__struct_FNA3D_CreateDevice wrap_struct = {
		.presentationParameters = presentationParameters,
		.debugMode = debugMode,
		.WRAP_RET = &wrap_ret
	};
	if (!emscripten_proxy_sync(emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(), WRAP__MAIN__FNA3D_CreateDevice, (void*)&wrap_struct)) {
		emscripten_run_script("console.error('wrap.fish: failed to proxy FNA3D_CreateDevice')");
		assert(0);
	}
	return wrap_ret;
}
```

And the wrapper is compiled in with the rest of FNA3D.

Then in the FNA C# code, where the native C is linked to, we replace the PInvoke binding:

```csharp
[DllImport(FNA3D, EntryPoint = "FNA3D_CreateDevice", CallingConvention = CallingConvention.Cdecl)]`
public static extern IntPtr FNA3D_CreateDevice(...);
```

...With one that calls our wrapper instead

```csharp
[DllImport(FNA3D, EntryPoint = "WRAP_FNA3D_CreateDevice", CallingConvention = CallingConvention.Cdecl)]`
public static extern IntPtr FNA3D_CreateDevice(...);
```

Ensuring that all the native calls to SDL went through the DOM thread instead of C#'s "main" deputy thread.

Okay. That was a lot. Does it work?

![AES Crypto error](assets/crypto-error.png)

uh.. okay. sure. i guess i'll just implement crypto myself.

Now does it work?

![Terraria gameplay](assets/terraria-works.png)

# Celeste

We also wanted to get Celeste working, since the person who shared the initial snippet had never released their work publicly. We thought that we could get it running, and maybe also get the Everest mod loader running with the game.

Celeste is also written in FNA, so we went through more or less the same process that we took to get Terraria compiled.

At this point, the SDL3 tooling was stable enough for us to upgrade, giving us access to `OffscreenCanvas`, so we would no longer need the proxy hack. Naturally, we still needed to [patch emscripten](https://github.com/MercuryWorkshop/celeste-wasm/blob/threads-v2/Makefile#L52) to work around not being able to "transfer" the canvas using the official api (because the threads are created by dotnet). nothing is ever without jank :)

We had another dependency issue though: Celeste uses the proprietary [FMOD](https://www.fmod.com) library for game audio instead of FAudio like Terraria.

FMOD _does_ provide emscripten builds, distributed as archive files, but as luck would have it- it also didn't like being run in a worker. We could use the wrap script again, but it isn't open source, so we couldn't just recompile it like we did for FNA. But, since we weren't modifying the native code itself, we could just extract the `.o` files from the FMOD build, and insert the codegenned c compiled as an object. However, FMOD is releasing actual multithreaded builds soon™.

After a couple of patches that aren't worth mentioning here:

![Celeste threaded](assets/celeste-works.png)

This time, we used a [proper diff system](https://github.com/MercuryWorkshop/celeste-wasm/tree/363b78fa6b10757ea2381ce3ea367eb69d6ea1fb/celeste/Patches/Code)

Okay cool. Now Everest. I wanna play the [strawberry jam](https://gamebanana.com/mods/424541) mod on my chromebook.

A mod loader is generally built around two components, a patched version of the game that provides an api, and a method of loading code at runtime and modifying behavior

Both are provided by MonoMod, an instrumentation framework for c# specifically built for game modding.

the patcher part modifies the game on disk, so no problem there. but the runtime modifications use a module called `RuntimeDetour`, which is very not supported on WebAssembly.

I'll explain how we ported it to NET's WASM SDK, but first it will help to take a little detour (haha) into the history of .NET Core

## .NET Core

The .NET platform used to be windows only and very closed source, along with a number of other limitations. Microsoft took so long to fix these that the [Mono Project](https://www.mono-project.com/) was created to reimplement the .NET runtime.

Microsoft [bought out Xamarin](https://blogs.microsoft.com/blog/2016/02/24/microsoft-to-acquire-xamarin-and-empower-more-developers-to-build-apps-on-any-device/) in 2016 and accquired Mono. A new runtime backend (CoreCLR) was merged with Mono's platform support and AOT tooling to create the horrifying amalgamation that became known as .NET Core.

This left the original mono project to fall behind, and eventually was left up to the wine project to maintain, leaving it as yet another example of Microsoft's [Embrace, Extend, Extingish](https://en.wikipedia.org/wiki/Embrace,_extend,_and_extinguish) strategy.

What does this mean for us? Microsoft's browser NET runtime is actually just regular Mono compiled to emscripten, with bits of .NET Core merged in. Outside of the browser though, Mono isn't used at all, since code runs on the new CoreCLR runtime.

## MonoMod.RuntimeDetour

This library (and MonoMod.RuntimeDetour.HookGen, which is a layer on top of this) is used by Everest mods to patch and modify the game.

Internally, it's powered by function detouring, a common tool for game modding/cheating. Typically though, it's associated with unmanaged languages like c/c++. It works a little differently in a language like c#.

Oversimplifying a little, the process MonoMod uses to hook into functions on desktop is:

- Copy the original method's IL bytecode into a new controlled method with modifications
- Call MethodBase.GetFunctionPointer() or "thunk" the runtime to retrieve pointers to the executable regions in memory that the jit code is held in
- Ask the OS kernel to disable write protection on the pages of memory where the jitted code is
- Write the bytes for a long jmp (`0xFF 0x25 <pointer>`) into the start of the function to redirect the control flow back into MonoMod.
- Force the JIT code for the new modified method to generate and move the control flow there.

This works because on desktop, all functions run through the CoreCLR JIT before they're executed, so all functions are guaranteed to have corresponding native code regions before they're even executed.

However, Mono WASM does not work this way. It runs in mostly interpreted mode with a limited “jit-traces” engine called the "jiterpreter", meaning not every method will have corresponding native code.

And even if it did - WebAssembly modules are _read only_, you can add new code at runtime, but you can't just hot patch existing code to mess with the internal state. WebAssembly is AOT compiled to native code on module instantiation, so it would be infeasible to allow runtime modification while keeping internal guarantees (and it's [also a security issue](https://developer.mozilla.org/en-US/docs/WebAssembly/Guides/Understanding_the_text_format#webassembly-tables#:~:text=WebAssembly%20could%20add%20an%20anyfunc,web)).

So instead of creating a detour by modifying raw assembly, what if we just disabled the jiterpreter and modified the IL bytecode? Since it's all interpreted on the fly, we should just be able to mess with the instructions loaded into memory.

To check the feasibility, I ran a simple test: run `MethodBase.GetILAsByteArray()`, then brute force search for those bytes in the webassembly memory and replace them with a bytecode NOP and return (`0x00 0x2A`)

![MonoMod bruteforce](assets/brute-monomod.png)

Now if we could just find the bytecode pointer programmatically...

There was the address from `MethodBase.GetFunctionPointer()`, but it wasn't anywhere near the code, and it definitely wasn't a native code region like on desktop. Eventually we realized that it was a pointer to the mono runtime's [internal `InterpMethod` struct](https://github.com/dotnet/runtime/blob/a2e1d21bb4faf914363968b812c990329ba92d8e/src/mono/mono/mini/interp/interp-internals.h#L121).

Since it would be easier to work with the structs in c, we added a new c file to the project with `<NativeFileReference>` and copied in the mono headers. Sure enough, when we passed in the address from GetFunctionPointer, we could read `ptr->method->name` and extract metadata from the function. Even with this though, we couldn't find the actual code pointer, as it was in a hash table that we didn't have the pointer to.

Suddenly, we noticed something really cool: since everything was eventually compiling to a single `.wasm` file, the c program that we had just created was linked in the same step as the mono runtime. This meant that we could access any internal mono function or object just by name. We were more or less executing code inside the runtime itself.

With our new ability to call any internal function, we found `mono_method_get_header_internal`, and calling it with the pointer we found earlier finally allowed us to get to the code region.

Now we just needed to find out what bytes to inject into the method that would let us override the control flow in a way that's compatible with monomod.

By looking at the MSIL documentation and [this Phrack Magazine post](https://phrack.org/issues/70/6) we were eventually able to come up with something that worked:

- insert one `ldarg.i` (`0xFE 0x0X`) corresponding to each argument in the original method
- call `System.Reflection.Emit` to generate a new dynamic function with the exact same signature as the original method
- insert an `ldc.i4` (`0x20 <int32>`) and put in the delegate pointer for the function we just created
- insert `calli` (`0x29`) to jump to the dynamic method
- add a return (`0x2A`) to prevent executing the rest of the function

Once the hooked function is called, it runs our dynamic method, which will:

- `ldarg` each argument and store it in a temporary array
- call into our c method, restoring the original IL and invalidating the source method
- run the mod's hook function and return to monomod

Calling the function would make Mono assert at runtime though. It turns out that we need to load a "metadata token" to determine the method's signature before we run `calli`, and since the dynamic method is technically in a different assembly, it wouldn't be able to resolve it by default.

This was a simple fix though, since the dyn method has the same signature as the original one, we just had to clone the parent method's metadata in C and insert it into the internal mono hash table.
This gave us a working detour system, but it turned out that last step broke in multithreaded mode, since each thread had it's own struct that needed to be modified.

There's probably a bypass for that, but at this point we figured it would just be easier to patch the runtime itself. After all, it's not like we have to worry about a user's individual setup, it's all running on the web.

Here's a simple patch, it would just clone the caller's signature when it saw our magic token `(0xF0F0F0F0)`, and we wouldn't need to mess with any tables

```diff
--- a/src/mono/mono/mini/interp/transform.c
+++ b/src/mono/mono/mini/interp/transform.c
@@ -3489,7 +3489,9 @@ interp_transform_call (TransformData *td, MonoMethod *method, MonoMethod *target
 	if (target_method == NULL) {
 		if (calli) {
-			if (method->wrapper_type != MONO_WRAPPER_NONE)
+			if (token == 0xF0F0F0F0)
+				csignature = method->signature;
+			else if (method->wrapper_type != MONO_WRAPPER_NONE)
 				csignature = (MonoMethodSignature *)mono_method_get_wrapper_data (method, token);
 			else {
```

Then, after recompiling dotnet, we could just put the patched sdk into the NuGet folder and have dotnet build the webassembly with our custom runtime.

Naturally, as with Everything C, we had somehow managed to trigger some memory corruption that the runtime wasn't happy about. But we got everything polished up eventually.

Now that we had a functional detour factory that worked in WebAssembly, we could slot it into MonoMod and start compiling everest.

# Everest

So far, we've just been porting games by decompiling, editing source, then making a new project with all the celeste code included and recompiling. How is that going to work with everest? It patches the celeste binary's bytecode itself, and we can't just use that as the base for decompilation because the patcher's output can't be translated to normal C#.

What we could do though is load the game binary at runtime, instead of compiling it with the project. The project we compile to wasm would just be a stub loader, and we could load any celeste binary.

```cs
Assembly celeste = Assembly.LoadFrom("/libsdl/Celeste.exe");
var Celeste = celeste.GetType("Celeste.Celeste");
celeste.GetType("Celeste.RunThread").GetMethod("WaitAll").Invoke(null, []);
```

It feels a little weird to be talking about running an _exe file_ in the browser, but since it's really just CIL bytecode inside a PE32 container, there's no reason it shouldn't work. And since we have dependencies directly added to the loader project, the runtime will find our web FNA before the real game's desktop FNA, so the game will call our libraries with no need for patching.

Of course, the game won't work, since we needed patches in a few places to get it to run in the browser without crashing.

We just made an entire framework for patching code at runtime though, so we can just use that, we just need to instantiate a `Hook` for the functions we need to patch then make our changes.

Here's an example hook, we need to force the window buffer to a specific size after the screen initializes, which we can do by finding `ApplyScreen` on the dynamically loaded assembly and running our code after it

```cs
void ApplyScreenHook(Action<object> orig, object self) {
	var Engine = celeste.GetType("Monocle.Engine");
    var Graphics = Engine.GetProperty("Graphics", BindingFlags.Public | BindingFlags.Static);
	orig(self);

	GraphicsDeviceManager graphics = (GraphicsDeviceManager)Graphics.GetValue(null);
	if (graphics == null) throw new Exception("Failed to get GraphicsDeviceManager");

	graphics.PreferredBackBufferWidth = 1920;
	graphics.PreferredBackBufferHeight = 1080;
	graphics.IsFullScreen = false;
	graphics.ApplyChanges();
}
Hook hook = new Hook(Celeste.GetMethod("ApplyScreen"), ApplyScreenHook);
```

Now that the loader doesn't care where the code comes from, we can just swap out `Celeste.exe` with the patched version from an everest install.

![Everest startup screen](assets/everest-works.png)

Do mods load finally? Nope, apparently it's crashing after trying to patch with monomod.

Wait, why is the mod loader patching the mod file?

Ah. I see. Everest is using monomod to modify the mod's calls to monomod. Sure. I think this is for compatibility reasons? Anyway there's no reason monomod.patcher shouldn't just work at runtime, it's just the thing that patches il binaries on disk. We just needed to copy all the original dependencies into the filesystem so that monomod has all the symbols. And since we're already shipping MonoMod.Patcher, we might as well just install Everest all in the browser by downloading the everest dll directly from github and running the patcher on Celeste.exe

That's a lot of patches!! Throughout the project, our patching system went from:
uploading entire source code to a git repo -> automated diff generation of `.patch` files -> hooking functions with RuntimeDetour -> patching Celeste.exe bytecode in the browser before the game starts

And as a bonus, now we're not hosting any Celeste IP, since all proprietary code gets loaded and patched inside the user's browser.

finally, mods and custom maps work

![Everest modded gameplay](assets/everest-mods-work.png)

## race to strawberry jam

The Strawberry Jam mod uses over 60 individual mods. Most would load fine, but a lot didn't.

we had to get all of them working.

Here's a fun issue - one of the mods tries to RuntimeDetour a function that's so small that the bytes of our jump patch overflow the code buffer. For cases like these, we found out how to abuse mono's hot reload system (which is a "module" that gets statically linked right at the end of the build, making it replaceable without a runtime patch) to replace function bodies instead of directly modifying the memory.

Another one, apparently wasm .NET is just straight up broken in a lot of cases. it makes sense, it's a pretty niche thing. the main use case is the Blazor web framework, and no one really uses it, not even microsoft. here's [another .NET bug](https://github.com/dotnet/runtime/issues/112262) we had to work around

But years later and no one really uses blazor, so despite a pretty good effort on the parts of the .NET maintainers the web support is best considered a beta. A not-insignificant amount of time was spent working around

Surprisingly, the rest of the mod compatibility issues were actually just subtle differences between the Mono Runtime and CoreCLR. No one plays Celeste on mono so no one noticed it.

First issue was a mod tripping a mono error during some reflection.

Again, the easiest way to get around this was just to patch the runtime. We're already running a modified sdk anyway, one more hackfix can't hurt.

FrostHelper won't load because the class override isn't valid? Well it is now.

```diff
--- a/src/mono/mono/metadata/class-setup-vtable.c
+++ b/src/mono/mono/metadata/class-setup-vtable.c
@@ -773,6 +773,7 @@ mono_method_get_method_definition (MonoMethod *method)
 static gboolean
 verify_class_overrides (MonoClass *klass, MonoMethod **overrides, int onum)
 {
+	return TRUE;
```

SecurityException? Who needs security anyway?

```diff
+++ b/src/mono/mono/metadata/class.c
@@ -6480,6 +6480,7 @@ can_access_member (MonoClass *access_klass, MonoClass *member_klass, MonoClass*
 gboolean
 mono_method_can_access_field (MonoMethod *method, MonoClassField *field)
 {
+	return TRUE;
```

And.. uhh. oh. ok

So it turns out that mono's internal implementation of `System.Reflection.Module.GetTypes` is Broken and does not follow spec (specifically, it doesn't properly work when some types can't be loaded, which is a Problem when you have "optional dependencies" on other mods). Since mod loaders are basically built around reflection and dynamic patching, Everest can't properly load some mods. That's not a trivial fix, but after patching the runtime again with a [reimplementation of the broken icall](https://github.com/r58Playz/FNA-WASM-Build/blob/1231d08a85a236bbae04c49803f36b80833bc2ac/dotnet.patch#L85) in c, all the the mono bugs are finally fixed and we can move on.

Just kidding. Apparently static initializer order [doesn't follow spec](https://github.com/dotnet/runtime/issues/77513) and is breaking some of our mods. Another runtime patch? Another runtime [patch](https://github.com/r58Playz/FNA-WASM-Build/blob/main/dotnet.patch#L193).

200 lines of mono patches, 53 mods, and roughly a year passed since we started the project.

Was it worth it? Probably.

![Strawberry Jam Prologue chapter preview](assets/strawberry-jam.png)

Since no one asked, how about we get the celeste multiplayer mod running in a browser?

![CelesteNet connected screen](assets/celestenet.png)

The helpful `[MonoModRelinkFrom]` attribute lets us declare a class to replace any system one, letting us intercept [CelesteNet](https://github.com/0x0ade/CelesteNet)'s creation of a `System.Net.Socket` with our own class that makes TCP connections over a [wisp protocol](https://github.com/MercuryWorkshop/wisp-protocol) proxy. We'll use the same wisp connection to download mods from gamebananna too, since it's normally blocked by CORS policy.

[mod downloader image]

<!--
# Steam for wasm

\[sgen-alloc error\]

Oh! Thats not good. We kinda need AOT

This is an error during code generation, so it's something that would have also happened at runtime during interpreted mode if the function was used. So something else is tripping up

Hey you know what time it is. Let's clone mono again and start recompiling with some new debug prints
\[machelpers.cs\]
Awesome. Fuck mac. Lets delete that file -->
