#!/bin/bash

zip -9 -r devtools.xpi . -x "*moz.build" -x "*/test*" -x "*.eslint*" -x "*/docs*" -x docs -x "*.idl" -x "*.cpp" -x "*.h" -x "*.md" -x "*LICENSE" -x "*README*" -x "shared/heapsnapshot/*" -x "*jar.mn" -x ".git*" -x .travis.yml -x *.sh -x "gecko*"
