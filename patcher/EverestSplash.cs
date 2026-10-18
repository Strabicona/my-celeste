using System;
using MonoMod;

namespace Celeste.Mod
{
    public static class patch_EverestSplashHandler
    {
        public static Action start;
        public static Action<string> send;
        public static Action stop;

		[MonoModIgnore]
        public static bool SplashRan { get; private set; }

        [MonoModReplace]
        public static void RunSplash(string targetRenderer = "")
        {
            start();
            SplashRan = true;
        }

        [MonoModReplace]
        private static void SendMessageToSplash(string message)
        {
            send(message);
        }

        [MonoModReplace]
        public static void StopSplash()
        {
            stop();
        }
    }
}
