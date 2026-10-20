# The Lost Age, in $(SITE)/tla. Its sidebar lists the home page and The
# Broken Seal as links back to Doxyfile.tbs's run.
@INCLUDE               = $(DOCS)/Doxyfile
OUTPUT_DIRECTORY       = $(SITE)/tla
WARN_LOGFILE           = $(SITE)/tla/warnings.log
INPUT                  = $(DOCS)/mainpage-tla.dox \
                         $(SRC)/tla \
                         games/tla/src \
                         games/tla/include
STRIP_FROM_PATH        = games/tla $(SRC)/tla $(DOCS) .
STRIP_FROM_INC_PATH    = games/tla/include
# No "Referenced by": each of the game's many overlays links at the same
# address, so placeholder names repeat across hundreds of files and the
# lists would name the wrong callers.
REFERENCED_BY_RELATION = NO
PREDEFINED            += TLA_EDITION_EN=1 GAME_TLA=1
