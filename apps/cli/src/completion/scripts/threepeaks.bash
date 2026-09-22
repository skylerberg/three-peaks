# bash completion for threepeaks. Install with: eval "$(threepeaks completion -s bash)"
_threepeaks() {
  local line value
  COMPREPLY=()
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    if [ "$line" = ":files" ]; then
      COMPREPLY=()
      return 0
    fi
    value=${line%%$'\t'*}
    COMPREPLY[${#COMPREPLY[@]}]=$(printf '%q' "$value")
  done < <(threepeaks __complete -- "${COMP_WORDS[@]:0:COMP_CWORD+1}" 2>/dev/null)
  # A lone folder is completed into rather than past, so no space follows it.
  if [ ${#COMPREPLY[@]} -eq 1 ] && [ "${COMPREPLY[0]%/}" != "${COMPREPLY[0]}" ]; then
    compopt -o nospace 2>/dev/null
  fi
}

complete -o default -o bashdefault -F _threepeaks threepeaks
