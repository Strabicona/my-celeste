using System;

namespace Celeste.Mod.Core
{
    public class patch_CoreModuleSettings
    {
        public bool? FastTextureLoading { get { return false; } set { Console.WriteLine($"Everest FTL disabled: Everest wanted to set {value}"); } }
    }
}
