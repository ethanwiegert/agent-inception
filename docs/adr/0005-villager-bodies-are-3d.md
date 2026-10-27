# Villager bodies are 3D Designs only

A villager's look is a Design built from 3D Parts in Materials, like any other Object. Pixel-art
sprites (`set_sprite`, extruded billboards) are removed in M8 rather than kept as a 2D option, so
every body lives in the same physics, lighting and Catalog as everything else, and agents learn
character creation from the built-in farmer Design.
