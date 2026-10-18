using System;

namespace Celeste.Mod
{
    public static partial class patch_Everest
    {
        public static string PathGame { get { return "/"; } set { Console.WriteLine($"Everest dum PathGame: {value}"); } }

        public static class patch_Loader
        {
            public static string PathMods { get { return "/libsdl/Celeste/Mods"; } set { Console.WriteLine($"Everest dum PathMods: {value}"); } }
        }
    }
}
