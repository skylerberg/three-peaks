#compdef threepeaks
# zsh completion for threepeaks. Install with:
#   threepeaks completion -s zsh > "${fpath[1]}/_threepeaks"
# or, after compinit: eval "$(threepeaks completion -s zsh)"

_threepeaks() {
  local -a lines vals disp dirs dirdisp
  local line value desc shown
  lines=("${(@f)$(threepeaks __complete -- "${(@)words[1,CURRENT]}" 2>/dev/null)}")
  if (( ${#lines} == 1 )) && [[ ${lines[1]} == ':files' ]]; then
    _files
    return
  fi
  for line in "${lines[@]}"; do
    [[ -z $line ]] && continue
    value=${line%%$'\t'*}
    desc=${line#*$'\t'}
    shown=$value
    [[ -n $desc ]] && shown="$value -- $desc"
    # A folder is completed into rather than past, so no space follows it.
    if [[ $value == */ ]]; then
      dirs+=("$value")
      dirdisp+=("$shown")
    else
      vals+=("$value")
      disp+=("$shown")
    fi
  done
  (( ${#vals} + ${#dirs} )) || return 1
  (( ${#vals} )) && compadd -U -l -d disp -a vals
  (( ${#dirs} )) && compadd -U -l -S '' -d dirdisp -a dirs
  return 0
}

if [[ $funcstack[1] == _threepeaks ]]; then
  _threepeaks "$@"
else
  compdef _threepeaks threepeaks
fi
