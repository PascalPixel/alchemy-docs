# Alchemy Docs: the documentation site for Alchemy, the Golden Sun
# decompilation. It reads an Alchemy checkout (ALCHEMY, by default the one
# beside this folder) and writes the site to out/site. Needs Doxygen 1.18,
# perl and Node (for the fonts, built here from Alchemy's font sheets and
# never committed). Run make, then serve out/site.
ALCHEMY ?= $(abspath ../alchemy)
DOCS := $(CURDIR)/doxygen
SRC := $(CURDIR)/out/src
SITE := $(CURDIR)/out/site
export DOCS SRC SITE
.DEFAULT_GOAL := docs

# Optional: the docs site in $(SITE) ($(DOCS)), one Doxygen run per
# game so that their same-named files, structures and functions stay apart:
# The Broken Seal and the home page in $(SITE), The Lost Age in
# $(SITE)/tla, joined afterwards into one sidebar and one search. Needs
# Doxygen 1.18 and perl; any Doxygen warning fails it. Doxygen 1.18.0 now
# and then dies of a bus error, so each run is tried twice. With perl one-liners,
# make docs first writes into $(SRC):
# - a copy of the README and of each folder guide whose links to other
#   guides point inside the site, and a page per guide titled by its first
#   heading (DOCS_GUIDES);
# - per game, a page of every BUG, DEAD and FAKEMATCH note with a link to
#   its line (DOCS_MARKS) and a page of the assembly that is code or engine
#   tables rather than a picture's or a table's wrapper (DOCS_ASM);
# - for The Broken Seal, the abilities each effect plays, from the effects'
#   "Abilities:" lines (DOCS_ABILITIES), and the places, from each scene's
#   file comment (DOCS_PLACES).
# Afterwards:
# - each page's title becomes an h1 (Doxygen writes a div); on the home page
#   the masthead shows the name and the README's title is for screen readers;
# - each run's sidebar (navtreedata.js and the navtreeindex files that
#   locate each page in it) is rearranged so that its top is Alchemy, The
#   Broken Seal and The Lost Age (DOCS_TREE);
# - navtree.js opens those three entries on load, and jumps rather than
#   scrolls (alchemy.css turns off every other animation).
DOXYGEN ?= doxygen
DOCS_GUIDES = sub get { open my $$i, "<", $$_[0] or die "$$_[0]: $$!"; local $$/; <$$i> } \
  sub put { open my $$o, ">", $$_[0] or die "$$_[0]: $$!"; print $$o $$_[1] } \
  sub norm { my $$p = shift; 1 while $$p =~ s{[^/]+/\.\./}{}; $$p } \
  sub fix { \
  my ($$t, $$base, $$g) = @_; \
  $$t =~ s{\[([^\]]*)\]\((?!https?:|\@ref|[\#])([^)\s]+)\)}{ \
  my ($$x, $$p) = ($$1, norm("$$base$$2")); \
  my ($$pg) = $$p =~ m{^games/(\w+)/src/(\w+)/README\.md$$} ? ("$$1_$$2") : $$p eq "games/tbs/src/MATCHING.md" ? ("tbs_matching") : (); \
  !$$pg ? "[$$x](https://github.com/PascalPixel/alchemy/blob/main/$$p)" : $$pg =~ /^$$g/ ? "[$$x](\@ref $$pg)" : "<a href=\"" . ($$g eq "tla" ? "../" : "tla/") . "$$pg.html\">$$x</a>" \
  }ge; \
  $$t =~ s{\(https://github\.com/PascalPixel/alchemy/blob/main/games/(\w+)/src/(\w+)/README\.md\)}{$$1 eq $$g ? "(\@ref $$1_$$2)" : "(https://github.com/PascalPixel/alchemy/blob/main/games/$$1/src/$$2/README.md)"}ge; \
  $$t \
  } \
  sub page { \
  my ($$f, $$id, $$g) = @_; \
  (my $$base = $$f) =~ s{[^/]*$$}{}; \
  my $$t = get($$f); \
  $$t =~ s/\A[\#][ ]+(.+?)(?:[ ]+\{[\#][\w-]+\})?\n+// or die "$$f: no title"; \
  my $$h = $$1; \
  put("$(SRC)/$$id.md", fix($$t, $$base, $$g)); \
  my ($$d) = $$base =~ m{(games/\w+/src/\w+)/$$}; $$d = "" unless $$d && grep { /[.][ch]$$/ } glob "$$d/* $$d/*/* $$d/*/*/*"; \
  "/** \\page $$id $$h\n\\includedoc $$id.md\n" . ($$d ? "\nSource: \\ref $$d \"" . ($$d =~ s{^games/\w+/}{}r) . "\"" : "") . " */\n"; \
  } \
  for my $$g ("tbs", "tla") { \
  my @p = map { my ($$d) = m{src/(\w+)/}; page($$_, "$${g}_$$d", $$g) } sort glob "games/$$g/src/*/README.md"; \
  push @p, page("games/tbs/src/MATCHING.md", "tbs_matching", "tbs") if $$g eq "tbs"; \
  put("$(SRC)/$$g/guides.dox", join "", @p); \
  } \
  put("$(SRC)/home-readme.md", fix(get("README.md"), "", "tbs")); \
  my $$i = fix(get("INSTALL.md"), "", "tbs"); \
  $$i =~ s/\A[\#][ ]+.*\n+//; \
  put("$(SRC)/install.md", $$i);
# A file's page is written PAGEOF(path) (its path below the game's folder) and
# resolved after the run by DOCS_LINKS, since Doxygen names a page by the
# file's name alone unless another file shares it.
DOCS_PAGE = sub page { "PAGEOF($$_[0])" }
DOCS_LINKS = BEGIN { for my $$h (glob "$$ENV{D}/*_8[ch].html") { open my $$f, "<", $$h or die; local $$/; my ($$p) = <$$f> =~ m{<title>(\S+) File Reference}; (my $$b = $$h) =~ s{.*/|\.html$$}{}g; $$m{$$p} = $$b if $$p } } s{PAGEOF\((.*?)\)}{$$m{$$1} // die "no page for $$1"}ge
DOCS_MARKS = $(DOCS_PAGE) \
  if (m{^games/\w+/(\S+?):(\d+):.*?(BUG|DEAD|FAKEMATCH(?:\([\w-]+\))?):?\s*(.*)}) { my ($$f, $$l, $$k, $$n) = ($$1, $$2, $$3, $$4); $$n =~ s{\s*\*/.*}{}; $$n =~ s/([\\\@<>|\#`])/\\$$1/g; push @{$$r{$$k}}, "| <a href=\"" . page($$f) . "_source.html\#l" . sprintf("%05d", $$l) . "\">$$f:$$l</a> | $$n |\n" } \
  END { print "/** \\page $$ENV{G}_marks Bugs, dead code and devices\n\nEvery note the source marks, with its line: BUG for a bug the original game has, kept with its fix behind BUGFIX; DEAD for code the cartridge keeps that cannot change the result; FAKEMATCH for a device that steers the compiler, by kind, with what it changes. Untyped FAKEMATCH tags predate the kinds.\n"; for my $$k (sort keys %r) { print "\n\#\# $$k (" . @{$$r{$$k}} . ")\n\n| Where | Note |\n|---|---|\n", @{$$r{$$k}} } print "*/\n" }
DOCS_ASM = chomp; my $$f = $$_; open my $$i, "<", $$f or die; my $$c = ""; while (<$$i>) { if (m{^\s*(?:@|//|/\*|\*)\s*(\S.*?)\s*(?:\*/)?\s*$$}) { $$c = $$1; last } last if m{^\s*[^\s\#]} } (my $$s = $$f) =~ s{^games/\w+/}{}; $$c =~ s/([\\\@<>|\#])/\\$$1/g; push @r, "| [$$s](https://github.com/PascalPixel/alchemy/blob/main/$$f) | $$c |\n"; \
  END { print "/** \\page $$ENV{G}_asm Assembly\n\nThe assembly that is code or engine tables: handwritten routines, far-call and overlay tables, the cartridge header. Doxygen does not read assembly, so each links to its file. The rest is wrappers that place a picture, a map or a table the build encodes, and each overlay\x27s entry and import tables.\n\n| File | What it is |\n|---|---|\n", @r, "*/\n" }
DOCS_ABILITIES = $(DOCS_PAGE) \
  if (m{^/// Abilities:\s*(.*?)\.?\s*$$}) { $$w = $$1 } elsif ($$w && m{^(?![/\#\s])\S.*?\b(\w+)\s*\(}) { my $$fn = $$1; for (split /;\s*|,\s*(?![^(]*\))/, $$w) { s/\s*\((?:scene )?kind.*//; push @r, [$$_, $$fn] unless /^none$$|used by no ability/ } $$w = "" } \
  END { print "/** \\page tbs_abilities Abilities\n\nEvery ability whose effect has its own entry point in the effect folder, from the line each entry point opens with, and the function that plays it. The numbers that make an ability hit are in \\ref tbs_battle.\n\n| Ability | Effect |\n|---|---|\n"; print "| $$_->[0] | $$_->[1]() |\n" for sort { lc $$a->[0] cmp lc $$b->[0] } @r; print "*/\n" }
DOCS_PLACES = $(DOCS_PAGE) \
  sub fin { (my $$s = $$ARGV) =~ s{^games/tbs/}{}; (my $$n = $$s) =~ s{.*/|\.c$$}{}g; $$t =~ s/^\s+//; $$t =~ s/(?<=[.!?])\s.*//; push @r, "| <a href=\"" . page($$s) . ".html\">$$n</a> | $$t |\n"; $$on = 0; close ARGV } \
  if (m{^/// \@file}) { $$on = 1; $$t = "" } elsif ($$on && m{^///\s*(.*?)\s*$$}) { my $$l = $$1; $$t .= " $$l"; fin() if $$l eq "" || $$t =~ /[.!?](?:\s|$$)/ } elsif ($$on) { fin() } \
  END { print "/** \\page tbs_places Places\n\nEvery place the party can walk around in, one scene overlay each, with the first sentence of its file\x27s comment. \\ref tbs_scene explains how a scene runs and how to find an event in it.\n\n| Scene | What happens there |\n|---|---|\n", @r, "*/\n" }
# Each run's sidebar comes out as its main page, then Source and Reference.
# In The Broken Seal's run, Source and Reference move under the game (its
# entries in tbs.js) and The Lost Age follows as a link; in The Lost Age's,
# they move under its main page (index.js), after links to the home page and
# The Broken Seal. The navtreeindex files, which give each page's place in
# the tree, follow: $$n is how many entries the game already holds.
DOCS_TREE = BEGIN { local $$/; open my $$f, "<", "$$ENV{D}/navtreedata.js" or die; ($$r) = <$$f> =~ /,\n(    \[ "Reference".*?\n    \] \])(?=\n  \] \])/s; open $$f, "<", "$$ENV{D}/$$ENV{J}.js" or die; $$n = () = <$$f> =~ /^    \[ /mg } \
  if ($$ARGV =~ /navtreedata\.js$$/) { s{"🌋 Alchemy"}{"Alchemy"}; s{,\n    \[ "Source", "files\.html", "files" \]}{}; s{,\n    \[ "Reference".*?\n    \] \](?=\n  \] \])}{}s; s{(\[ "☀️ The Broken Seal", "tbs\.html", "tbs" \])}{$$1,\n    [ "⚓️ The Lost Age", "tla/index.html", null ]}; s{\[ "⚓️ The Lost Age", "index\.html", "index" \]}{[ "Alchemy", "../index.html", null ],\n    [ "☀️ The Broken Seal", "../tbs.html", null ],\n    [ "⚓️ The Lost Age", "index.html", "index" ]} } \
  elsif ($$ARGV =~ m{/$$ENV{J}\.js$$}) { s{\n\];}{,\n    [ "Source", "files.html", "files" ],\n$$r\n];} } \
  else { my %m = $$ENV{J} eq "tbs" ? (2 => "1,$$n", 3 => "1," . ($$n + 1)) : (0 => "2", 1 => "2,$$n", 2 => "2," . ($$n + 1)); s{\[(\d)([,\]])}{exists $$m{$$1} ? "[$$m{$$1}$$2" : "[$$1$$2"}ge }
# The two runs as one site: each run's sidebar holds the other game's
# entries, copied beside it under a tla__ or tbs__ prefix with their links
# pointed across (DOCS_JOIN_TREE), and each run's search index holds both
# games' names, every result marked with its game (DOCS_JOIN_SEARCH).
DOCS_JOIN_TREE = sub get { open my $$i, "<:raw", $$_[0] or die "$$_[0]: $$!"; local $$/; <$$i> } \
  sub put { open my $$o, ">:raw", $$_[0] or die "$$_[0]: $$!"; print $$o $$_[1] } \
  sub nav { my ($$d) = @_; grep { !m{/navtree(?:data|index\d*)?\.js$$} && get($$_) =~ /(?:\A|\n)var \w+ =\n\[/ } glob "$$d/*.js" } \
  sub move { my ($$t, $$u, $$p) = @_; $$t =~ s{\[ ("(?:[^"\\]|\\.)*"), "([^"]*)", }{"[ $$1, \"" . ($$2 =~ m{^(?:https?:|javascript:|$$)} ? $$2 : "$$u$$2") . "\", "}ge; $$t =~ s{, "(\w+)" \]}{, "$$p$$1" ]}g; $$t =~ s{(\A|\n)var (\w+) =}{$$1var $$p$$2 =}; $$t } \
  my ($$R, $$L) = ("$(SITE)", "$(SITE)/tla"); \
  for my $$f (nav($$R)) { (my $$b = $$f) =~ s{.*/}{}; put("$$L/tbs__$$b", move(get($$f), "../", "tbs__")) } \
  for my $$f (nav($$L)) { (my $$b = $$f) =~ s{.*/}{}; next if $$b =~ /^tbs__/; put("$$R/tla__$$b", move(get($$f), "tla/", "tla__")) } \
  my $$root = get("$$R/navtreedata.js"); \
  my ($$tree) = $$root =~ /(var NAVTREE =\n\[.*?\n\];)/s or die "no NAVTREE"; \
  (my $$there = move($$tree, "../", "tbs__")) =~ s{\[ "⚓️ The Lost Age", "\.\./tla/index\.html", null \]}{[ "⚓️ The Lost Age", "index.html", "index" ]} or die "no Lost Age entry"; \
  $$there =~ s{var tbs__NAVTREE =}{var NAVTREE =}; \
  my $$tla = get("$$L/navtreedata.js"); \
  $$tla =~ s{var NAVTREE =\n\[.*?\n\];}{$$there}s or die; \
  put("$$L/navtreedata.js", $$tla); \
  $$root =~ s{\[ "⚓️ The Lost Age", "tla/index\.html", null \]}{[ "⚓️ The Lost Age", "tla/index.html", "tla__index" ]} or die "no Lost Age link"; \
  put("$$R/navtreedata.js", $$root);
DOCS_JOIN_SEARCH = use utf8; \
  sub get { open my $$i, "<:utf8", $$_[0] or die "$$_[0]: $$!"; local $$/; <$$i> } \
  sub put { open my $$o, ">:utf8", $$_[0] or die "$$_[0]: $$!"; print $$o $$_[1] } \
  my %mark = (tbs => "☀️", tla => "⚓️"); \
  my (%names, %letters, %rows); \
  for my $$g ("tbs", "tla") { \
  my $$d = $$g eq "tbs" ? "$(SITE)/search" : "$(SITE)/tla/search"; \
  my $$sd = get("$$d/searchdata.js"); \
  my ($$with) = $$sd =~ /var indexSectionsWithContent =\n\{\n(.*?)\n\};/s or die; \
  my ($$nm) = $$sd =~ /var indexSectionNames =\n\{\n(.*?)\n\};/s or die; \
  %names = $$nm =~ /(\d+): "(\w+)"/g; \
  for (split /\n/, $$with) { \
  my ($$c, $$s) = /(\d+): "(.*)"/ or next; \
  my @l = $$s =~ /\X/g; \
  for my $$i (0 .. $$\#l) { \
  my $$f = sprintf "%s/%s_%x.js", $$d, $$names{$$c}, $$i; \
  $$letters{$$c}{$$l[$$i]} = 1; \
  for my $$row (get($$f) =~ /^  (\[\x27.*?\]\]\]),?$$/mg) { \
  $$row =~ s{\[\x27\.\./([^\x27]*)\x27,(\d),\x27([^\x27]*)\x27\]}{"[\x27$$g:$$1\x27,$$2,\x27" . ($$3 eq "" ? $$mark{$$g} : "$$mark{$$g} $$3") . "\x27]"}ge; \
  my ($$id, $$name, $$res) = $$row =~ /^\[\x27([^\x27]*)\x27,\[\x27((?:[^\x27\\]|\\.)*)\x27(.*)\]\]$$/ or die "row: $$row"; \
  my $$e = $$rows{$$c}{$$l[$$i]}{$$name} //= ["$${id}_$$g", ""]; \
  $$e->[1] .= $$res; \
  } \
  } \
  } \
  } \
  for my $$g ("tbs", "tla") { \
  my $$d = $$g eq "tbs" ? "$(SITE)/search" : "$(SITE)/tla/search"; \
  my $$up = $$g eq "tbs" ? { tbs => "../", tla => "../tla/" } : { tbs => "../../", tla => "../" }; \
  unlink grep { !m{/search(?:data)?\.js$$|\.css$$} } glob "$$d/*.js"; \
  my $$with = ""; \
  for my $$c (sort { $$a <=> $$b } keys %letters) { \
  my @l = sort keys %{$$letters{$$c}}; \
  $$with .= "  $$c: \"" . join("", @l) . "\",\n"; \
  for my $$i (0 .. $$\#l) { \
  my $$h = $$rows{$$c}{$$l[$$i]} || {}; \
  my @r = map { "[\x27$$h->{$$_}[0]\x27,[\x27$$_\x27$$h->{$$_}[1]]]" } sort { lc $$a cmp lc $$b } keys %$$h; \
  s{\[\x27(tbs|tla):}{[\x27$$up->{$$1}}g for @r; \
  put(sprintf("%s/%s_%x.js", $$d, $$names{$$c}, $$i), "var searchData=\n[\n  " . join(",\n  ", @r) . "\n];\n"); \
  } \
  } \
  $$with =~ s/,\n\z/\n/; \
  my $$sd = get("$$d/searchdata.js"); \
  $$sd =~ s/(var indexSectionsWithContent =\n\{\n).*?(\n\};)/$$1$$with$$2/s; \
  $$sd =~ s/\n\n\};/\n};/; \
  put("$$d/searchdata.js", $$sd); \
  }
DOCS_TITLE = s{<div class="title">(.*?)</div>}{<h1 class="title">$$1</h1>}
# The footer, which Doxygen writes after the scrolling content, moved to its end.
DOCS_FOOTER = s{(</div><!-- doc-content -->.*?)(<footer class="site-footer">.*?</footer>\n)}{$$2$$1}s
DOCS_NAVJS = s{Math\.min\(elapsed / duration, 1\)}{1}; s{behavior: .smooth.}{behavior: "auto"}; s{(\n  showRoot\(\);)}{$$1\n  const openTop = () => { const r = o.node.children[0]; if (!r || !r.children || !r.children.length) return setTimeout(openTop, 20); r.children.forEach(n => { if (!n.expanded) expandNode(o, n, true, false); }); };\n  openTop();}
.PHONY: docs
docs:
	@case "$$($(DOXYGEN) --version 2>/dev/null)" in 1.18.*) ;; *) echo "make docs needs Doxygen 1.18 ($(DOXYGEN) is $$($(DOXYGEN) --version 2>/dev/null || echo missing))" >&2; exit 1;; esac
	@rm -rf $(SRC) $(SITE) && mkdir -p $(SITE)/tla $(SRC)/tbs $(SRC)/tla $(SRC)/fonts
	cd $(ALCHEMY) && node $(CURDIR)/fonts/weyard.js . $(SRC)/fonts
	cd $(ALCHEMY) && perl -e '$(DOCS_GUIDES)'
	cd $(ALCHEMY) && git grep -n -E '// (BUG|DEAD):|FAKEMATCH' -- 'games/tbs/*.c' 'games/tbs/*.h' | G=tbs perl -ne '$(DOCS_MARKS)' > $(SRC)/tbs/marks.dox
	cd $(ALCHEMY) && git grep -n -E '// (BUG|DEAD):|FAKEMATCH' -- 'games/tla/*.c' 'games/tla/*.h' | G=tla perl -ne '$(DOCS_MARKS)' > $(SRC)/tla/marks.dox
	cd $(ALCHEMY) && git ls-files 'games/tbs/src/*.s' 'games/tbs/src/*.S' | grep -v -E '/(graphics|map)/|/(import|entry)/' | G=tbs perl -ne '$(DOCS_ASM)' > $(SRC)/tbs/asm.dox
	cd $(ALCHEMY) && git ls-files 'games/tla/src/*.s' 'games/tla/src/*.S' | grep -v -E '/(graphics|map)/|/(import|entry)/' | G=tla perl -ne '$(DOCS_ASM)' > $(SRC)/tla/asm.dox
	cd $(ALCHEMY) && perl -ne '$(DOCS_ABILITIES)' $$(git ls-files 'games/tbs/src/effect/*.c') > $(SRC)/tbs/abilities.dox
	cd $(ALCHEMY) && perl -ne '$(DOCS_PLACES)' $$(git ls-files 'games/tbs/src/scene/*.c' | grep -v -E '/(import|entry|common)/') > $(SRC)/tbs/places.dox
	cd $(ALCHEMY) && $(DOXYGEN) $(DOCS)/Doxyfile.tbs || $(DOXYGEN) $(DOCS)/Doxyfile.tbs
	cd $(ALCHEMY) && $(DOXYGEN) $(DOCS)/Doxyfile.tla || $(DOXYGEN) $(DOCS)/Doxyfile.tla
	@for w in $(SITE)/warnings.log $(SITE)/tla/warnings.log; do test ! -s $$w || { cat $$w >&2; echo "make docs: Doxygen warnings ($$w)" >&2; exit 1; }; done
	D=$(SITE) perl -pi -e '$(DOCS_LINKS)' $(SITE)/tbs_marks.html $(SITE)/tbs_places.html
	D=$(SITE)/tla perl -pi -e '$(DOCS_LINKS)' $(SITE)/tla/tla_marks.html
	find $(SITE) -name '*.html' -exec perl -pi -e '$(DOCS_TITLE)' {} +
	find $(SITE) -name '*.html' -exec perl -0777 -pi -e '$(DOCS_FOOTER)' {} +
	perl -pi -e 's{<h1 class="doxsection">}{<h1 class="doxsection sr-only">}' $(SITE)/index.html
	find $(SITE)/tla -name '*.html' -exec perl -pi -e 's{class="masthead-name" href="index.html"}{class="masthead-name" href="../index.html"}' {} +
	D=$(SITE) J=tbs perl -0777 -i -pe '$(DOCS_TREE)' $(SITE)/navtreedata.js $(SITE)/tbs.js $(SITE)/navtreeindex*.js
	D=$(SITE)/tla J=index perl -0777 -i -pe '$(DOCS_TREE)' $(SITE)/tla/navtreedata.js $(SITE)/tla/index.js $(SITE)/tla/navtreeindex*.js
	perl -0777 -i -pe '$(DOCS_NAVJS)' $(SITE)/navtree.js $(SITE)/tla/navtree.js
	perl -e '$(DOCS_JOIN_TREE)'
	perl -e '$(DOCS_JOIN_SEARCH)'
