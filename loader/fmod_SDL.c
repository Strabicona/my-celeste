void FMOD_SDL_Register(void *system) {}

int FMOD_Studio_System_SetListenerAttributes(void *system, int index, void *attributes, void *attenuationposition);
int FMOD_Studio_System_SetListenerAttributes_2(void *system, int index, void *attributes) {
	return FMOD_Studio_System_SetListenerAttributes(system, index, attributes, (void*)0);
}

int FMOD_Studio_EventInstance_SetParameterByName(void *instance, void *name, float val, int ignoreseekspeed);
int FMOD_Studio_EventInstance_SetParameterByName_2(void *instance, void *name, float val) {
	return FMOD_Studio_EventInstance_SetParameterByName(instance, name, val, 0);
}
