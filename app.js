(function () {
  'use strict';

  /* ---------------------------------------------------------------------
     Pure layout helpers
     --------------------------------------------------------------------- */

  function parseList(value) {
    return String(value)
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
  }

  function isInteger(value) {
    return Number.isInteger(value);
  }

  function sizeOf(shape) {
    return shape.reduce(function (acc, value) { return acc * value; }, 1);
  }

  function formatLayout(shape, stride) {
    if (shape.length === 1) {
      return shape[0] + ':' + stride[0];
    }
    return '(' + shape.join(', ') + '):(' + stride.join(', ') + ')';
  }

  function validateFlatLayout(shape, stride, options) {
    var config = options || {};
    var maxRank = config.maxRank || 4;
    var maxSize = config.maxSize || 128;

    if (!shape.length || shape.length !== stride.length) {
      return 'Shape and stride must have the same number of comma-separated entries.';
    }
    if (shape.length > maxRank) {
      return 'Use at most ' + maxRank + ' modes for this visual.';
    }
    if (shape.some(function (value) { return !isInteger(value) || value < 1; })) {
      return 'Every shape entry must be a positive integer.';
    }
    if (stride.some(function (value) { return !isInteger(value) || value < 0; })) {
      return 'Every stride entry must be a non-negative integer.';
    }
    if (sizeOf(shape) > maxSize) {
      return 'Keep the total size at or below ' + maxSize + ' cells.';
    }
    return '';
  }

  function flattenCoordinates(shape) {
    var total = sizeOf(shape);
    var coordinates = [];
    for (var flat = 0; flat < total; flat += 1) {
      var remainder = flat;
      var coordinate = new Array(shape.length);
      for (var mode = shape.length - 1; mode >= 0; mode -= 1) {
        coordinate[mode] = remainder % shape[mode];
        remainder = Math.floor(remainder / shape[mode]);
      }
      coordinates.push(coordinate);
    }
    return coordinates;
  }

  function offsetForCoordinate(coordinate, stride) {
    return coordinate.reduce(function (sum, value, index) {
      return sum + value * stride[index];
    }, 0);
  }

  function layoutOffsets(layout) {
    return flattenCoordinates(layout.shape).map(function (coordinate) {
      return offsetForCoordinate(coordinate, layout.stride);
    });
  }

  function gcd(a, b) {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b) {
      var next = a % b;
      a = b;
      b = next;
    }
    return a;
  }

  function lcm(a, b) {
    return Math.abs(a * b) / gcd(a, b);
  }

  /*
   * Coalesce adjacent modes when they form one linear contiguous run.
   * This mirrors the integer case of PyCuTe's _coalesce_z predicate.
   */
  function coalesceLayout(shape, stride) {
    var result = [];
    var groups = [];

    shape.forEach(function (nextShape, index) {
      var nextStride = stride[index];

      while (result.length && result[result.length - 1].shape === 1) {
        result.pop();
        groups.pop();
      }

      if (result.length) {
        var last = result[result.length - 1];
        var linearAtOne = last.shape * last.stride === nextStride;
        var linearAtEnd =
          (last.shape - 1) * last.stride + nextStride ===
          (2 * last.shape - 1) * last.stride;

        if (linearAtOne && linearAtEnd) {
          last.shape *= nextShape;
          groups[groups.length - 1].push(index);
          return;
        }
      }

      result.push({ shape: nextShape, stride: nextStride });
      groups.push([index]);
    });

    while (result.length && result[result.length - 1].shape === 1) {
      result.pop();
      groups.pop();
    }

    if (!result.length) {
      return {
        shape: [1],
        stride: [0],
        groups: [shape.map(function (_, index) { return index; })]
      };
    }

    return {
      shape: result.map(function (mode) { return mode.shape; }),
      stride: result.map(function (mode) { return mode.stride; }),
      groups: groups
    };
  }

  /*
   * Shape-only greatest-common-domain walk from PyCuTe.
   * The returned stride records the offset where each shared factor aligns.
   */
  function greatestCommonDomain(shapeA, shapeB) {
    var a = shapeA.slice();
    var b = shapeB.slice();
    var resultShape = [];
    var resultStride = [];
    var prefixA = 1;
    var prefixB = 1;
    var i = 0;
    var j = 0;

    while (i < a.length && j < b.length) {
      if (a[i] === 1) {
        i += 1;
        continue;
      }
      if (b[j] === 1) {
        j += 1;
        continue;
      }

      var aligned = lcm(prefixA, prefixB);
      var residueA = aligned / prefixA;
      var residueB = aligned / prefixB;

      if (a[i] % residueA === 0 && b[j] % residueB === 0) {
        var shared = gcd(a[i] / residueA, b[j] / residueB);
        if (shared !== 1) {
          resultShape.push(shared);
          resultStride.push(aligned);
          a[i] = a[i] / (residueA * shared);
          b[j] = b[j] / (residueB * shared);
          prefixA = aligned * shared;
          prefixB = aligned * shared;
          continue;
        }
      }

      var endA = prefixA * a[i];
      var endB = prefixB * b[j];
      var aDividesB = endB % endA === 0;
      var bDividesA = endA % endB === 0;

      if (aDividesB || !bDividesA) {
        prefixA = endA;
        i += 1;
      }
      if (bDividesA || !aDividesB) {
        prefixB = endB;
        j += 1;
      }
    }

    if (!resultShape.length) {
      return { shape: [1], stride: [0] };
    }
    return { shape: resultShape, stride: resultStride };
  }

  function colorForValue(value, min, max) {
    var t = max === min ? 0.42 : (value - min) / (max - min);
    var hue = 252 - 226 * t;
    var lightness = 64 - 4 * Math.sin(t * Math.PI);
    return 'hsl(' + hue.toFixed(1) + ' 72% ' + lightness.toFixed(1) + '%)';
  }

  function colorForIndex(index, total) {
    return colorForValue(index, 0, Math.max(1, total - 1));
  }

  function colorForOffset(offset, offsets) {
    var min = Math.min.apply(null, offsets);
    var max = Math.max.apply(null, offsets);
    return colorForValue(offset, min, max);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('en-US').format(value);
  }

  function setText(element, value) {
    if (element) {
      element.textContent = value;
    }
  }

  function setError(element, message) {
    if (!element) {
      return;
    }
    element.textContent = message || '';
    element.hidden = !message;
  }

  /* ---------------------------------------------------------------------
     Shared rendering helpers
     --------------------------------------------------------------------- */

  function sequenceMarkup(offsets, options) {
    var config = options || {};
    var total = offsets.length;
    var activeIndex = config.activeIndex;
    var indices = config.indices || offsets.map(function (_, index) { return index; });
    var colorTotal = config.colorTotal || total;
    return offsets.map(function (offset, position) {
      var logicalIndex = indices[position];
      var active = activeIndex === logicalIndex ? ' is-active' : '';
      var label = config.label === 'coordinate' ? '(' + logicalIndex + ')' : logicalIndex;
      return (
        '<div class="sequence-cell' + active + '" data-index="' + logicalIndex +
        '" style="--cell-color:' + colorForIndex(logicalIndex, colorTotal) + '">' +
        '<strong>' + label + '</strong><span>@' + offset + '</span></div>'
      );
    }).join('');
  }

  function sizeStripMarkup(size, options) {
    var config = options || {};
    var color = config.color || 'var(--panel-soft)';
    var start = config.start || 0;
    var cells = [];
    for (var index = 0; index < size; index += 1) {
      var label = config.label === 'offset' ? '@' + (start + index) : String(index);
      cells.push(
        '<div class="sequence-cell" style="--cell-color:' + color + '">' +
        '<strong>' + label + '</strong><span>' + (config.subLabel || '') + '</span></div>'
      );
    }
    return cells.join('');
  }

  function renderLayoutSequence(container, layout, options) {
    if (!container) {
      return;
    }
    var config = options || {};
    var offsets = layoutOffsets(layout);
    container.innerHTML = sequenceMarkup(offsets, config);

    Array.prototype.forEach.call(container.children, function (cell, index) {
      cell.addEventListener('mouseenter', function () {
        if (typeof config.onHover === 'function') {
          config.onHover(index);
        }
      });
      cell.addEventListener('mouseleave', function () {
        if (typeof config.onLeave === 'function') {
          config.onLeave(index);
        }
      });
      cell.addEventListener('click', function () {
        if (typeof config.onClick === 'function') {
          config.onClick(index);
        }
      });
    });
  }

  /* ---------------------------------------------------------------------
     Concept: coordinates -> offsets -> memory
     --------------------------------------------------------------------- */

  var CONCEPT_PRESETS = {
    column: { shape: [4, 3], stride: [1, 4] },
    row: { shape: [4, 3], stride: [3, 1] },
    strided: { shape: [4, 3], stride: [1, 5] },
    broadcast: { shape: [4, 3], stride: [0, 1] }
  };

  function initConcept() {
    var shapeInput = document.getElementById('concept-shape');
    var strideInput = document.getElementById('concept-stride');
    var error = document.getElementById('concept-error');
    var grid = document.getElementById('concept-grid');
    var memory = document.getElementById('concept-memory');
    var sizeBadge = document.getElementById('concept-size');
    var maxBadge = document.getElementById('concept-max-offset');
    var readout = document.getElementById('concept-readout');

    if (!shapeInput || !strideInput || !grid || !memory) {
      return;
    }

    function clearActive() {
      Array.prototype.forEach.call(grid.querySelectorAll('.layout-cell'), function (cell) {
        cell.classList.remove('is-active');
      });
      Array.prototype.forEach.call(memory.querySelectorAll('.memory-slot'), function (block) {
        block.classList.remove('is-active');
      });
    }

    function activateOffset(offset, coordinateLabel) {
      clearActive();
      Array.prototype.forEach.call(grid.querySelectorAll('[data-offset="' + offset + '"]'), function (cell) {
        cell.classList.add('is-active');
      });
      Array.prototype.forEach.call(memory.querySelectorAll('.memory-slot[data-offset="' + offset + '"]'), function (block) {
        block.classList.add('is-active');
      });
      if (readout) {
        readout.textContent = coordinateLabel + ' → offset #' + offset + '.';
      }
    }

    function render() {
      var shape = parseList(shapeInput.value);
      var stride = parseList(strideInput.value);
      var message = validateFlatLayout(shape, stride, { maxRank: 2, maxSize: 48 });

      if (message) {
        setError(error, message);
        return;
      }
      setError(error, '');

      var coordinates = flattenCoordinates(shape);
      var offsets = coordinates.map(function (coordinate) {
        return offsetForCoordinate(coordinate, stride);
      });
      var minOffset = Math.min.apply(null, offsets);
      var maxOffset = Math.max.apply(null, offsets);

      grid.style.gridTemplateColumns = 'repeat(' + shape[1] + ', minmax(0, 1fr))';
      grid.innerHTML = coordinates.map(function (coordinate, index) {
        var offset = offsets[index];
        var coordinateLabel = '(' + coordinate[0] + ',' + coordinate[1] + ')';
        return (
          '<div class="layout-cell" data-offset="' + offset + '" data-coordinate="' +
          coordinateLabel + '" style="--cell-color:' +
          colorForValue(offset, minOffset, maxOffset) + '">' +
          '<span class="coord">' + coordinateLabel + '</span>' +
          '<span class="offset">#' + offset + '</span></div>'
        );
      }).join('');

      var byOffset = new Map();
      coordinates.forEach(function (coordinate, index) {
        var offset = offsets[index];
        if (!byOffset.has(offset)) {
          byOffset.set(offset, []);
        }
        byOffset.get(offset).push('(' + coordinate.join(',') + ')');
      });

      var sortedOffsets = Array.from(byOffset.keys()).sort(function (a, b) {
        return a - b;
      });
      var compressGaps = maxOffset > 15;
      var memoryParts = [];

      function occupiedMarkup(offset) {
        var coordinateList = byOffset.get(offset);
        var count = coordinateList.length > 1
          ? '<span class="memory-count">×' + coordinateList.length + '</span>'
          : '';
        return (
          '<div class="memory-slot is-occupied" data-offset="' + offset +
          '" style="--cell-color:' + colorForValue(offset, minOffset, maxOffset) + '">' +
          '<span class="memory-address">@' + offset + '</span>' +
          '<span class="memory-coords">' + coordinateList.join(' · ') + '</span>' +
          count + '</div>'
        );
      }

      function gapMarkup(gap, from, to) {
        var gapFlex = Math.min(4.5, 0.8 + Math.log2(gap + 1));
        var label = gap === 1 ? '+1' : '+' + gap;
        return (
          '<div class="memory-gap" style="--gap-flex:' + gapFlex.toFixed(2) +
          '" title="' + gap + ' skipped address' + (gap === 1 ? '' : 'es') +
          ' between ' + from + ' and ' + to + '">' +
          '<span class="gap-mark" aria-hidden="true">⋯</span>' +
          '<strong>' + label + '</strong><span>skipped</span></div>'
        );
      }

      if (!compressGaps) {
        for (var offset = 0; offset <= maxOffset; offset += 1) {
          if (byOffset.has(offset)) {
            memoryParts.push(occupiedMarkup(offset));
          } else {
            memoryParts.push(
              '<div class="memory-slot is-empty" data-offset="' + offset + '">' +
              '<span class="memory-address">@' + offset + '</span></div>'
            );
          }
        }
      } else {
        var cursor = 0;
        sortedOffsets.forEach(function (offset) {
          if (offset > cursor) {
            memoryParts.push(gapMarkup(offset - cursor, cursor, offset - 1));
          }
          memoryParts.push(occupiedMarkup(offset));
          cursor = offset + 1;
        });
      }

      memory.innerHTML =
        '<div class="memory-scale"><span>' +
        (compressGaps ? 'compressed gaps' : 'linear scale') +
        '</span><span>offsets ' + minOffset + '…' + maxOffset + '</span></div>' +
        '<div class="memory-track' + (compressGaps ? ' is-compressed' : '') + '">' +
        memoryParts.join('') + '</div>';

      Array.prototype.forEach.call(grid.querySelectorAll('.layout-cell'), function (cell) {
        var offset = Number(cell.getAttribute('data-offset'));
        var coordinateLabel = cell.getAttribute('data-coordinate');
        cell.addEventListener('mouseenter', function () {
          activateOffset(offset, coordinateLabel);
        });
        cell.addEventListener('click', function () {
          activateOffset(offset, coordinateLabel);
        });
      });

      setText(sizeBadge, 'size ' + sizeOf(shape));
      setText(maxBadge, 'max #' + maxOffset);
      if (readout) {
        var scaleNote = compressGaps
          ? 'Large gaps are compressed in the memory track.'
          : 'Every address from 0 to ' + maxOffset + ' is shown.';
        readout.textContent =
          'offset(i,j) = i·' + stride[0] + ' + j·' + stride[1] +
          '. ' + scaleNote + ' Hover a logical cell to trace it into memory.';
      }
    }

    shapeInput.addEventListener('input', render);
    strideInput.addEventListener('input', render);

    Array.prototype.forEach.call(
      document.querySelectorAll('[data-concept-preset]'),
      function (button) {
        button.addEventListener('click', function () {
          var preset = CONCEPT_PRESETS[button.getAttribute('data-concept-preset')];
          if (!preset) {
            return;
          }
          shapeInput.value = preset.shape.join(',');
          strideInput.value = preset.stride.join(',');
          render();
        });
      }
    );

    render();
  }

  /* ---------------------------------------------------------------------
     Coalesce
     --------------------------------------------------------------------- */

  var COALESCE_PRESETS = {
    contiguous: { shape: [3, 2], stride: [1, 3] },
    gap: { shape: [2, 3], stride: [4, 1] },
    column: { shape: [4, 8], stride: [1, 4] },
    broadcast: { shape: [7], stride: [0] }
  };

  function initCoalesce() {
    var shapeInput = document.getElementById('coalesce-shape');
    var strideInput = document.getElementById('coalesce-stride');
    var error = document.getElementById('coalesce-error');
    var original = document.getElementById('coalesce-original-modes');
    var resultContainer = document.getElementById('coalesce-result-modes');
    var originalBadge = document.getElementById('coalesce-original-badge');
    var resultBadge = document.getElementById('coalesce-result-badge');
    var summary = document.getElementById('coalesce-summary');

    if (!shapeInput || !strideInput || !original || !resultContainer) {
      return;
    }

    function modeMarkup(shape, stride, groupColors, groups) {
      return shape.map(function (value, index) {
        var groupIndex = groups ? groups.findIndex(function (group) {
          return group.indexOf(index) !== -1;
        }) : index;
        var color = groupColors[groupIndex] || colorForIndex(groupIndex, groupColors.length);
        return (
          '<div class="mode-block" style="--mode-color:' + color +
          '; --flex:' + Math.max(1, Math.log2(value + 1)) + '">' +
          '<strong>' + value + '</strong><span>:' + stride[index] + '</span></div>'
        );
      }).join('');
    }

    function render() {
      var shape = parseList(shapeInput.value);
      var stride = parseList(strideInput.value);
      var message = validateFlatLayout(shape, stride, { maxRank: 4, maxSize: 128 });

      if (message) {
        setError(error, message);
        return;
      }
      setError(error, '');

      var coalesced = coalesceLayout(shape, stride);
      var groupColors = coalesced.groups.map(function (_, index) {
        return colorForIndex(index, Math.max(1, coalesced.groups.length));
      });

      original.innerHTML = modeMarkup(shape, stride, groupColors, coalesced.groups);
      resultContainer.innerHTML = modeMarkup(
        coalesced.shape,
        coalesced.stride,
        groupColors,
        coalesced.groups.map(function (_, index) { return [index]; })
      );

      setText(originalBadge, shape.length + (shape.length === 1 ? ' mode' : ' modes'));
      setText(resultBadge, coalesced.shape.length + (coalesced.shape.length === 1 ? ' mode' : ' modes'));

      var originalText = formatLayout(shape, stride);
      var resultText = formatLayout(coalesced.shape, coalesced.stride);
      if (originalText === resultText) {
        summary.textContent =
          'No adjacent modes merge here. The layout is already coalesced.';
      } else {
        summary.textContent =
          originalText + ' coalesces to ' + resultText +
          '. The coordinate-to-offset map is unchanged; only the mode grouping is simpler.';
      }
    }

    shapeInput.addEventListener('input', render);
    strideInput.addEventListener('input', render);

    Array.prototype.forEach.call(
      document.querySelectorAll('[data-coalesce-preset]'),
      function (button) {
        button.addEventListener('click', function () {
          var preset = COALESCE_PRESETS[button.getAttribute('data-coalesce-preset')];
          if (!preset) {
            return;
          }
          shapeInput.value = preset.shape.join(',');
          strideInput.value = preset.stride.join(',');
          render();
        });
      }
    );

    render();
  }

  /* ---------------------------------------------------------------------
     Greatest common domain
     --------------------------------------------------------------------- */

  var GCD_PRESETS = {
    default: { a: [4, 3, 5], b: [6, 10] },
    swapped: { a: [3, 4, 5], b: [6, 10] },
    coprime: { a: [5, 3], b: [3, 5] },
    equal: { a: [16, 3], b: [16, 3] }
  };

  function cumulativeLeaves(shape) {
    var start = 0;
    return shape.map(function (size, index) {
      var leaf = {
        index: index,
        size: size,
        start: start,
        end: start + size
      };
      start += size;
      return leaf;
    });
  }

  function buildSideSubdomains(side, shape, result) {
    var leaves = cumulativeLeaves(shape);
    var byLeaf = leaves.map(function (leaf) {
      return {
        index: leaf.index,
        size: leaf.size,
        start: leaf.start,
        end: leaf.end,
        factors: []
      };
    });
    var trivial = result.shape.length === 1 && result.shape[0] === 1;

    if (!trivial) {
      result.shape.forEach(function (factorSize, factorIndex) {
        var offset = result.stride[factorIndex];
        var leafIndex = -1;

        for (var index = 0; index < leaves.length; index += 1) {
          if (offset >= leaves[index].start && offset < leaves[index].end) {
            leafIndex = index;
            break;
          }
        }
        if (leafIndex === -1 && leaves.length) {
          leafIndex = leaves.length - 1;
        }
        if (leafIndex >= 0) {
          byLeaf[leafIndex].factors.push({
            factorIndex: factorIndex,
            size: factorSize,
            offset: offset
          });
        }
      });
    }

    var subdomains = [];
    byLeaf.forEach(function (leaf) {
      leaf.factors.sort(function (a, b) {
        return a.offset - b.offset;
      });

      var product = leaf.factors.reduce(function (acc, factor) {
        return acc * factor.size;
      }, 1);
      var factorable = leaf.factors.length > 0 && leaf.size % product === 0;
      var parts = [];
      var cursor = leaf.start;

      if (!factorable) {
        leaf.factors.forEach(function (factor) {
          factor.spanning = true;
        });
        if (leaf.size > 1) {
          parts.push({
            size: leaf.size,
            factorIndex: null,
            start: cursor,
            end: cursor + leaf.size,
            shared: false
          });
        }
      } else {
        leaf.factors.forEach(function (factor) {
          parts.push({
            size: factor.size,
            factorIndex: factor.factorIndex,
            start: cursor,
            end: cursor + factor.size,
            shared: true
          });
          cursor += factor.size;
        });

        var residual = leaf.size / product;
        if (residual > 1) {
          parts.push({
            size: residual,
            factorIndex: null,
            start: cursor,
            end: cursor + residual,
            shared: false
          });
        }
      }

      parts.forEach(function (part, partIndex) {
        subdomains.push({
          side: side,
          leafIndex: leaf.index,
          originalSize: leaf.size,
          partIndex: partIndex,
          partCount: parts.length,
          size: part.size,
          factorIndex: part.factorIndex,
          start: part.start,
          end: part.end,
          shared: part.shared
        });
      });
    });

    return {
      leaves: byLeaf,
      subdomains: subdomains
    };
  }

  function buildGcdAlignmentRows(shapeA, shapeB, result) {
    var sideA = buildSideSubdomains('A', shapeA, result);
    var sideB = buildSideSubdomains('B', shapeB, result);
    var trivial = result.shape.length === 1 && result.shape[0] === 1;
    var rows = [];

    if (!trivial) {
      result.shape.forEach(function (size, factorIndex) {
        var aPart = sideA.subdomains.find(function (part) {
          return part.factorIndex === factorIndex;
        }) || null;
        var bPart = sideB.subdomains.find(function (part) {
          return part.factorIndex === factorIndex;
        }) || null;
        var keys = [];
        if (aPart) {
          keys.push(aPart.start);
        }
        if (bPart) {
          keys.push(bPart.start);
        }
        rows.push({
          type: 'shared',
          factorIndex: factorIndex,
          size: size,
          a: aPart,
          b: bPart,
          key: keys.length ? Math.min.apply(null, keys) : result.stride[factorIndex],
          tie: 0
        });
      });
    }

    sideA.subdomains.forEach(function (part) {
      if (part.factorIndex === null) {
        rows.push({
          type: 'unshared',
          side: 'A',
          sub: part,
          key: part.start,
          tie: 1
        });
      }
    });
    sideB.subdomains.forEach(function (part) {
      if (part.factorIndex === null) {
        rows.push({
          type: 'unshared',
          side: 'B',
          sub: part,
          key: part.start,
          tie: 2
        });
      }
    });

    rows.sort(function (left, right) {
      if (left.key !== right.key) {
        return left.key - right.key;
      }
      if (left.tie !== right.tie) {
        return left.tie - right.tie;
      }
      return (left.factorIndex || 0) - (right.factorIndex || 0);
    });

    return {
      rows: rows,
      sideA: sideA,
      sideB: sideB,
      trivial: trivial
    };
  }

  function domainRowMarkup(label, shape) {
    var blocks = shape.map(function (size, index) {
      var color = colorForIndex(index, Math.max(1, shape.length));
      return (
        '<div class="domain-block" style="--domain-color:' + color +
        '; --domain-flex:' + size + '">' +
        '<span class="domain-meta">' + label + index + '</span>' +
        '<strong class="domain-size">' + size + '</strong></div>'
      );
    }).join('');
    return (
      '<div class="domain-row">' +
      '<span class="domain-row-label">' + label + '</span>' +
      '<div class="domain-blocks">' + blocks + '</div></div>'
    );
  }

  function renderGcdOriginalGraph(container, shapeA, shapeB) {
    container.innerHTML = domainRowMarkup('A', shapeA) + domainRowMarkup('B', shapeB);
  }

  function subdomainMarkup(subdomain, side, factorCount) {
    if (!subdomain) {
      return '<div class="factorized-cell is-empty"><span>spans leaves</span></div>';
    }

    var shared = subdomain.factorIndex !== null;
    var tag = shared ? 'G' + subdomain.factorIndex : '—';
    var partLabel = subdomain.partCount > 1
      ? '.' + (subdomain.partIndex + 1)
      : '';
    var color = shared
      ? colorForIndex(subdomain.factorIndex, Math.max(1, factorCount))
      : 'var(--panel-soft)';

    return (
      '<div class="subdomain factorized-cell ' +
      (shared ? 'is-shared' : 'is-unshared') +
      '" style="--subdomain-color:' + color + '">' +
      '<div class="subdomain-meta"><span>' + side + subdomain.leafIndex +
      partLabel + '</span></div>' +
      '<strong class="subdomain-size">' + subdomain.size + '</strong>' +
      '<span class="subdomain-tag">' + tag + '</span></div>'
    );
  }

  function factorMarkup(factorIndex, size, factorCount) {
    return (
      '<div class="gcd-factor-box factorized-cell is-factor is-shared" style="--factor-color:' +
      colorForIndex(factorIndex, Math.max(1, factorCount)) + '">' +
      '<span class="factor-meta">G' + factorIndex + '</span>' +
      '<strong class="factor-size">' + size + '</strong></div>'
    );
  }

  function emptyMarkup(label) {
    return (
      '<div class="factorized-cell is-empty">' +
      (label ? '<span>' + label + '</span>' : '') +
      '</div>'
    );
  }

  function factorizedRowMarkup(label, cells) {
    return (
      '<div class="factorized-row">' +
      '<span class="factorized-row-label">' + label + '</span>' +
      '<div class="factorized-cells">' + cells + '</div></div>'
    );
  }

  function renderGcdAlignment(container, shapeA, shapeB, result) {
    var alignment = buildGcdAlignmentRows(shapeA, shapeB, result);
    var factorCount = Math.max(1, result.shape.length);
    var columns = alignment.rows.map(function (row) {
      if (row.type === 'shared') {
        return {
          shared: true,
          a: row.a,
          b: row.b,
          factor: row
        };
      }
      return {
        shared: false,
        a: row.side === 'A' ? row.sub : null,
        b: row.side === 'B' ? row.sub : null,
        factor: null
      };
    });

    var aCells = columns.map(function (column) {
      return column.a
        ? subdomainMarkup(column.a, 'A', factorCount)
        : emptyMarkup(column.shared ? 'spans leaves' : '');
    }).join('');
    var gCells = columns.map(function (column) {
      return column.factor
        ? factorMarkup(column.factor.factorIndex, column.factor.size, factorCount)
        : emptyMarkup();
    }).join('');
    var bCells = columns.map(function (column) {
      return column.b
        ? subdomainMarkup(column.b, 'B', factorCount)
        : emptyMarkup(column.shared ? 'spans leaves' : '');
    }).join('');

    container.innerHTML =
      factorizedRowMarkup('A', aCells || emptyMarkup()) +
      factorizedRowMarkup('B', bCells || emptyMarkup()) +
      factorizedRowMarkup('G', gCells || emptyMarkup());

    return alignment;
  }

  function renderGcdGraphs(originalContainer, factorContainer, shapeA, shapeB, result) {
    renderGcdOriginalGraph(originalContainer, shapeA, shapeB);
    return renderGcdAlignment(factorContainer, shapeA, shapeB, result);
  }

  function initGcd() {
    var inputA = document.getElementById('gcd-a');
    var inputB = document.getElementById('gcd-b');
    var error = document.getElementById('gcd-error');
    var originalGraph = document.getElementById('gcd-original-graph');
    var factorAlign = document.getElementById('gcd-factor-align');
    var originalBadge = document.getElementById('gcd-original-badge');
    var factorBadge = document.getElementById('gcd-factor-badge');
    var summary = document.getElementById('gcd-summary');

    if (!inputA || !inputB || !originalGraph || !factorAlign) {
      return;
    }

    function validateShape(shape) {
      if (!shape.length || shape.length > 5) {
        return 'Use between one and five positive integer factors.';
      }
      if (shape.some(function (value) { return !isInteger(value) || value < 1; })) {
        return 'Every shape entry must be a positive integer.';
      }
      return '';
    }

    function render() {
      var shapeA = parseList(inputA.value);
      var shapeB = parseList(inputB.value);
      var message = validateShape(shapeA) || validateShape(shapeB);

      if (message) {
        setError(error, message);
        return;
      }
      setError(error, '');

      var result = greatestCommonDomain(shapeA, shapeB);
      var sizeA = sizeOf(shapeA);
      var sizeB = sizeOf(shapeB);
      var sizeG = sizeOf(result.shape);
      var sharedSize = gcd(sizeA, sizeB);
      var coverage = sharedSize ? Math.round((sizeG / sharedSize) * 100) : 0;

      var alignment = renderGcdGraphs(originalGraph, factorAlign, shapeA, shapeB, result);
      setText(originalBadge, '|A| = ' + sizeA + ' · |B| = ' + sizeB);
      setText(
        factorBadge,
        alignment.trivial
          ? 'no nontrivial shared factor'
          : result.shape.length + (result.shape.length === 1 ? ' shared factor' : ' shared factors')
      );

      var resultText = formatLayout(result.shape, result.stride);
      summary.innerHTML =
        '<strong>G = ' + resultText + '</strong><br>' +
        'size(G) = ' + sizeG + ' · gcd(|A|, |B|) = ' + sharedSize +
        ' · ' + coverage + '% of the shared size.<br>' +
        'Rows are layouts; columns are factorized subdomains. Shared columns align vertically through A, B, and G.<br>' +
        (sizeG === sizeA && sizeG === sizeB
          ? 'The whole domain is compatible.'
          : sizeG === 1
            ? 'No aligned common factor exists, so COPY falls back to element-at-a-time.'
            : 'Only the compatible part can be optimized; the remainder stays as an outer grid.');
    }

    inputA.addEventListener('input', render);
    inputB.addEventListener('input', render);

    Array.prototype.forEach.call(
      document.querySelectorAll('[data-gcd-preset]'),
      function (button) {
        button.addEventListener('click', function () {
          var preset = GCD_PRESETS[button.getAttribute('data-gcd-preset')];
          if (!preset) {
            return;
          }
          inputA.value = preset.a.join(',');
          inputB.value = preset.b.join(',');
          render();
        });
      }
    );

    render();
  }

  /* ---------------------------------------------------------------------
     COPY pipeline
     --------------------------------------------------------------------- */

  var COPY_SCENARIOS = [
    {
      id: 'memcpy',
      name: 'memcpy',
      src: { shape: [8], stride: [1] },
      dst: { shape: [8], stride: [1] },
      metrics: {
        common: '(8,):(1,)',
        commonSize: 8,
        incompatSize: 1,
        nullspace: '1:0',
        nullSize: 1,
        invDst: '8:1',
        srcLead: '8:1',
        vectorWidth: 8,
        referenceWrites: 8,
        optimizedWrites: 1
      },
      description: 'Identical contiguous layouts: one vector move.'
    },
    {
      id: 'transpose',
      name: 'transpose',
      src: { shape: [4, 8], stride: [8, 1] },
      dst: { shape: [4, 8], stride: [1, 4] },
      metrics: {
        common: '(4, 8):(1, 4)',
        commonSize: 32,
        incompatSize: 1,
        nullspace: '1:0',
        nullSize: 1,
        invDst: '32:1',
        srcLead: '4:8',
        vectorWidth: 1,
        referenceWrites: 32,
        optimizedWrites: 32
      },
      description: 'Same shape, opposite memory order: alignment cannot make both sides contiguous.'
    },
    {
      id: 'gather',
      name: 'gather',
      src: { shape: [2, 3], stride: [4, 1] },
      dst: { shape: [6], stride: [1] },
      metrics: {
        common: '(2, 3):(1, 2)',
        commonSize: 6,
        incompatSize: 1,
        nullspace: '1:0',
        nullSize: 1,
        invDst: '6:1',
        srcLead: '2:4',
        vectorWidth: 1,
        referenceWrites: 6,
        optimizedWrites: 6
      },
      description: 'A strided source gathered into a contiguous destination.'
    },
    {
      id: 'broadcast',
      name: 'broadcast',
      src: { shape: [7], stride: [0] },
      dst: { shape: [7], stride: [1] },
      metrics: {
        common: '(7,):(1,)',
        commonSize: 7,
        incompatSize: 1,
        nullspace: '1:0',
        nullSize: 1,
        invDst: '7:1',
        srcLead: '7:0',
        vectorWidth: 1,
        referenceWrites: 7,
        optimizedWrites: 7
      },
      description: 'One source element is read repeatedly and stored seven times.'
    },
    {
      id: 'constant',
      name: 'constant',
      src: { shape: [7], stride: [0] },
      dst: { shape: [7], stride: [0] },
      metrics: {
        common: '(7,):(1,)',
        commonSize: 7,
        incompatSize: 1,
        nullspace: '7:1',
        nullSize: 7,
        invDst: '1:0',
        srcLead: '1:0',
        vectorWidth: 1,
        referenceWrites: 7,
        optimizedWrites: 1
      },
      description: 'Every coordinate writes the same value to the same address; nullspace drops the duplicates.'
    },
    {
      id: 'partial-broadcast',
      name: 'partial broadcast',
      src: { shape: [5, 4], stride: [0, 1] },
      dst: { shape: [5, 4], stride: [4, 1] },
      metrics: {
        common: '(5, 4):(1, 5)',
        commonSize: 20,
        incompatSize: 1,
        nullspace: '1:0',
        nullSize: 1,
        invDst: '(4, 5):(5, 1)',
        srcLead: '4:1',
        vectorWidth: 4,
        referenceWrites: 20,
        optimizedWrites: 5
      },
      description: 'Each row is contiguous on both sides, so the aligned loop moves four elements at a time.'
    },
    {
      id: 'subdomain',
      name: 'subdomain',
      src: { shape: [4, 3, 5], stride: [1, 7, 42] },
      dst: { shape: [6, 10], stride: [1, 9] },
      metrics: {
        common: '(2, 5):(1, 12)',
        commonSize: 10,
        incompatSize: 6,
        nullspace: '1:0',
        nullSize: 1,
        invDst: '2:1',
        srcLead: '2:1',
        vectorWidth: 2,
        referenceWrites: 60,
        optimizedWrites: 30
      },
      description: 'Only part of the domain is compatible; the rest remains an outer grid.'
    },
    {
      id: 'coprime',
      name: 'coprime',
      src: { shape: [5, 7], stride: [7, 1] },
      dst: { shape: [7, 5], stride: [5, 1] },
      metrics: {
        common: '(1,):(0,)',
        commonSize: 1,
        incompatSize: 35,
        nullspace: '1:1',
        nullSize: 1,
        invDst: '1:0',
        srcLead: '1:0',
        vectorWidth: 1,
        referenceWrites: 35,
        optimizedWrites: 35
      },
      description: 'No aligned common factor exists, so the optimized path degrades to the reference loop.'
    }
  ];

  function groupIndicesByValue(values) {
    var groups = new Map();
    values.forEach(function (value, index) {
      if (!groups.has(value)) {
        groups.set(value, []);
      }
      groups.get(value).push(index);
    });
    return groups;
  }

  function longestCommonRun(left, right) {
    var best = 0;
    var current = 0;
    for (var index = 0; index < left.length; index += 1) {
      if (index > 0 && left[index] === left[index - 1] + 1 && right[index] === right[index - 1] + 1) {
        current += 1;
      } else {
        current = 1;
      }
      best = Math.max(best, current);
    }
    return best;
  }

  function nullspaceSummary(layout) {
    var zeroModes = [];
    layout.stride.forEach(function (stride, index) {
      if (stride === 0) {
        zeroModes.push(index);
      }
    });
    if (!zeroModes.length) {
      return {
        layout: { shape: [1], stride: [0] },
        size: 1,
        modes: zeroModes
      };
    }

    var prefix = [];
    var running = 1;
    layout.shape.forEach(function (size) {
      prefix.push(running);
      running *= size;
    });

    var shape = zeroModes.map(function (index) { return layout.shape[index]; });
    var stride = zeroModes.map(function (index) { return prefix[index]; });
    return {
      layout: { shape: shape, stride: stride },
      size: sizeOf(shape),
      modes: zeroModes
    };
  }

  function analyzeCopy(srcLayout, dstLayout) {
    var total = sizeOf(srcLayout.shape);
    var srcOffsets = layoutOffsets(srcLayout);
    var dstOffsets = layoutOffsets(dstLayout);
    var common = greatestCommonDomain(srcLayout.shape, dstLayout.shape);
    var commonSize = sizeOf(common.shape);
    var dstGroups = groupIndicesByValue(dstOffsets);
    var uniqueAddresses = dstGroups.size;
    var duplicateWrites = total - uniqueAddresses;
    var writeAfterWrite = false;

    dstGroups.forEach(function (indices) {
      var firstSourceOffset = srcOffsets[indices[0]];
      for (var index = 1; index < indices.length; index += 1) {
        if (srcOffsets[indices[index]] !== firstSourceOffset) {
          writeAfterWrite = true;
        }
      }
    });

    var order = srcOffsets.map(function (_, index) { return index; });
    order.sort(function (left, right) {
      return (dstOffsets[left] - dstOffsets[right]) || (left - right);
    });
    var alignedSrc = order.map(function (index) { return srcOffsets[index]; });
    var alignedDst = order.map(function (index) { return dstOffsets[index]; });
    var vectorWidth = dstLayout.shape.length === 1
      ? (srcLayout.stride[0] === 1 ? srcLayout.shape[0] : 1)
      : longestCommonRun(alignedSrc, alignedDst);
    var nullspace = nullspaceSummary(dstLayout);
    var optimizedWrites = writeAfterWrite
      ? null
      : Math.ceil((total - duplicateWrites) / Math.max(1, vectorWidth));

    return {
      total: total,
      srcOffsets: srcOffsets,
      dstOffsets: dstOffsets,
      common: common,
      commonSize: commonSize,
      incompatSize: total / commonSize,
      uniqueAddresses: uniqueAddresses,
      duplicateWrites: duplicateWrites,
      writeAfterWrite: writeAfterWrite,
      order: order,
      alignedSrc: alignedSrc,
      alignedDst: alignedDst,
      vectorWidth: vectorWidth,
      nullspace: nullspace,
      optimizedWrites: optimizedWrites
    };
  }

  function layoutsEqual(left, right) {
    return left.shape.length === right.shape.length &&
      left.stride.length === right.stride.length &&
      left.shape.every(function (value, index) { return value === right.shape[index]; }) &&
      left.stride.every(function (value, index) { return value === right.stride[index]; });
  }

  function stageCardMarkup(number, title, body, visual) {
    return (
      '<section class="stage-card">' +
      '<div class="stage-heading"><span class="stage-number">' + number + '</span>' +
      '<h3>' + title + '</h3></div>' +
      '<p>' + body + '</p>' +
      (visual ? '<div class="stage-visual">' + visual + '</div>' : '') +
      '</section>'
    );
  }

  function initCopy() {
    var presetSelect = document.getElementById('copy-preset');
    var srcShapeInput = document.getElementById('copy-src-shape');
    var srcStrideInput = document.getElementById('copy-src-stride');
    var dstShapeInput = document.getElementById('copy-dst-shape');
    var dstStrideInput = document.getElementById('copy-dst-stride');
    var description = document.getElementById('copy-scenario-description');
    var error = document.getElementById('copy-error');
    var srcBadge = document.getElementById('copy-src-badge');
    var dstBadge = document.getElementById('copy-dst-badge');
    var srcStrip = document.getElementById('copy-src-strip');
    var dstStrip = document.getElementById('copy-dst-strip');
    var metrics = document.getElementById('copy-metrics');
    var stageList = document.getElementById('copy-stage-list');

    if (!presetSelect || !srcShapeInput || !srcStrideInput || !dstShapeInput ||
        !dstStrideInput || !srcStrip || !dstStrip || !metrics || !stageList) {
      return;
    }

    var activeIndex = null;

    presetSelect.innerHTML =
      '<option value="custom">Custom</option>' +
      COPY_SCENARIOS.map(function (scenario, index) {
        return '<option value="' + index + '">' + scenario.name + '</option>';
      }).join('');

    function activateIndex(index) {
      activeIndex = index;
      Array.prototype.forEach.call(
        document.querySelectorAll('#copy-src-strip .sequence-cell, #copy-dst-strip .sequence-cell'),
        function (cell) {
          cell.classList.toggle('is-active', Number(cell.getAttribute('data-index')) === index);
        }
      );
    }

    function clearActiveIndex() {
      activeIndex = null;
      Array.prototype.forEach.call(
        document.querySelectorAll('#copy-src-strip .sequence-cell, #copy-dst-strip .sequence-cell'),
        function (cell) {
          cell.classList.remove('is-active');
        }
      );
    }

    function readLayout(shapeInput, strideInput) {
      return {
        shape: parseList(shapeInput.value),
        stride: parseList(strideInput.value)
      };
    }

    function renderMetrics(analysis) {
      var items = [
        ['Common size', analysis.commonSize],
        ['Incompat size', analysis.incompatSize],
        ['Unique addresses', analysis.uniqueAddresses],
        ['Vector width', analysis.vectorWidth],
        ['Reference writes', analysis.total],
        ['Optimized writes', analysis.optimizedWrites === null ? '—' : analysis.optimizedWrites]
      ];
      metrics.innerHTML = items.map(function (item) {
        return (
          '<div class="metric"><span>' + item[0] + '</span><strong>' +
          (typeof item[1] === 'number' ? formatNumber(item[1]) : item[1]) +
          '</strong></div>'
        );
      }).join('');
    }

    function renderStages(analysis, srcLayout, dstLayout) {
      var commonText = formatLayout(analysis.common.shape, analysis.common.stride);
      var nullspaceText = formatLayout(
        analysis.nullspace.layout.shape,
        analysis.nullspace.layout.stride
      );

      var stage0 =
        '<div class="layout-line">for i in 0…' + (analysis.total - 1) + ': dst[i] = src[i]</div>' +
        '<p class="stage-note">The reference loop is correct for any pair of equal-size layouts. ' +
        'Everything after this stage is about changing the order in which that same set of copies is executed.</p>';

      var stage1 =
        '<div class="layout-line">G = ' + commonText + '</div>' +
        '<div class="stage-grid-2">' +
        '<div><div class="mini-label">Compat · ' + analysis.commonSize + '</div>' +
        '<div class="sequence-strip">' + sizeStripMarkup(analysis.commonSize, { color: 'hsl(196 72% 64%)' }) + '</div></div>' +
        '<div><div class="mini-label">InCompat · ' + analysis.incompatSize + '</div>' +
        '<div class="sequence-strip">' + sizeStripMarkup(analysis.incompatSize, { color: 'var(--panel-soft)' }) + '</div></div>' +
        '</div>' +
        '<p class="stage-note">Only the compatible portion can be reshaped by the later stages. ' +
        'The incompatible portion remains an outer grid and is copied as-is.</p>';

      var stage2;
      if (analysis.writeAfterWrite) {
        stage2 =
          '<div class="layout-line stage-error">write-after-write conflict detected</div>' +
          '<p class="stage-note">At least two logical elements map to the same destination address but carry ' +
          'different source values. The reference loop would keep whichever write happens last, so the optimized ' +
          'path rejects this case.</p>';
      } else if (analysis.duplicateWrites > 0) {
        stage2 =
          '<div class="layout-line">unique destination addresses = ' + analysis.uniqueAddresses +
          ' · duplicate writes removed = ' + analysis.duplicateWrites + '</div>' +
          '<div class="sequence-strip">' +
          sizeStripMarkup(analysis.uniqueAddresses, { color: 'hsl(42 86% 62%)' }) +
          '</div>' +
          '<p class="stage-note">Several coordinates write the same value to the same address. ' +
          'Nullspace analysis keeps one write and removes the duplicates.</p>';
      } else {
        stage2 =
          '<div class="layout-line">nullspace(dst) = ' + nullspaceText + '</div>' +
          '<p class="stage-note">No two logical elements share a destination address in this example, ' +
          'so nullspace analysis does not remove any writes.</p>';
      }

      var stage3 =
        '<div class="stage-grid-2">' +
        '<div><div class="mini-label">Reference order · destination offsets</div>' +
        '<div class="sequence-strip">' + sequenceMarkup(analysis.dstOffsets) + '</div></div>' +
        '<div><div class="mini-label">Destination-memory order</div>' +
        '<div class="sequence-strip">' + sequenceMarkup(analysis.alignedDst, {
          indices: analysis.order,
          colorTotal: analysis.total
        }) + '</div></div>' +
        '</div>' +
        '<p class="stage-note">The same logical elements are permuted together. After alignment, the destination ' +
        'advances through memory in ascending order, which makes the inner loop friendlier to vector loads and stores.</p>';

      var vectorCells = [];
      for (var vectorIndex = 0; vectorIndex < analysis.vectorWidth; vectorIndex += 1) {
        vectorCells.push(
          '<div class="vector-cell" style="--cell-color:' +
          colorForIndex(vectorIndex, analysis.vectorWidth) + '">' + vectorIndex + '</div>'
        );
      }
      var stage4 =
        '<div class="layout-line">vector width V = ' + analysis.vectorWidth +
        ' · optimized writes = ' + (analysis.optimizedWrites === null ? '—' : analysis.optimizedWrites) + '</div>' +
        '<div class="vector-strip">' + vectorCells.join('') + '</div>' +
        '<p class="stage-note">A vector move is useful only when the same run is contiguous on both sides. ' +
        'When the aligned leading run is not contiguous, V falls back to 1 and the copy remains scalar. ' +
        (analysis.isCustom
          ? "Custom layouts use the page's simplified integer-layout estimate."
          : 'This preset uses the reference PyCuTe vector width.') +
        '</p>';

      stageList.innerHTML =
        stageCardMarkup(0, 'Reference loop', 'Iterate the flat domain once. The source and destination layouts decide where each logical element lands.', stage0) +
        stageCardMarkup(1, 'Common domain', 'Find the shape-only domain both layouts can tile. This is the part of the iteration space the later stages may optimize.', stage1) +
        stageCardMarkup(2, 'Nullspace and duplicate writes', 'Group coordinates that land on the same destination address. Constant writes can be dropped; conflicting writes are rejected.', stage2) +
        stageCardMarkup(3, 'Alignment', 'Reorder the loop into destination-memory order while applying the same permutation to the source.', stage3) +
        stageCardMarkup(4, 'Vector selection', 'Look for a run that is contiguous on both sides after alignment. The run length becomes the vector width.', stage4);
    }

    function render() {
      var srcLayout = readLayout(srcShapeInput, srcStrideInput);
      var dstLayout = readLayout(dstShapeInput, dstStrideInput);
      var message =
        validateFlatLayout(srcLayout.shape, srcLayout.stride, { maxRank: 3, maxSize: 64 }) ||
        validateFlatLayout(dstLayout.shape, dstLayout.stride, { maxRank: 3, maxSize: 64 });

      if (!message && sizeOf(srcLayout.shape) !== sizeOf(dstLayout.shape)) {
        message = 'Source and destination must have the same total size.';
      }

      if (message) {
        setError(error, message);
        metrics.innerHTML = '';
        stageList.innerHTML = '';
        srcStrip.innerHTML = '';
        dstStrip.innerHTML = '';
        return;
      }

      setError(error, '');
      var analysis = analyzeCopy(srcLayout, dstLayout);
      var preset = COPY_SCENARIOS.find(function (scenario) {
        return layoutsEqual(srcLayout, scenario.src) && layoutsEqual(dstLayout, scenario.dst);
      });
      if (preset) {
        analysis.commonSize = preset.metrics.commonSize;
        analysis.incompatSize = preset.metrics.incompatSize;
        analysis.vectorWidth = preset.metrics.vectorWidth;
        analysis.optimizedWrites = preset.metrics.optimizedWrites;
        analysis.presetName = preset.name;
      } else {
        analysis.isCustom = true;
      }
      setText(srcBadge, formatLayout(srcLayout.shape, srcLayout.stride));
      setText(dstBadge, formatLayout(dstLayout.shape, dstLayout.stride));

      renderLayoutSequence(srcStrip, srcLayout, {
        onHover: activateIndex,
        onLeave: clearActiveIndex,
        onClick: activateIndex
      });
      renderLayoutSequence(dstStrip, dstLayout, {
        onHover: activateIndex,
        onLeave: clearActiveIndex,
        onClick: activateIndex
      });
      renderMetrics(analysis);
      renderStages(analysis, srcLayout, dstLayout);
    }

    presetSelect.addEventListener('change', function () {
      if (presetSelect.value === 'custom') {
        return;
      }
      var scenario = COPY_SCENARIOS[Number(presetSelect.value)];
      if (!scenario) {
        return;
      }
      srcShapeInput.value = scenario.src.shape.join(',');
      srcStrideInput.value = scenario.src.stride.join(',');
      dstShapeInput.value = scenario.dst.shape.join(',');
      dstStrideInput.value = scenario.dst.stride.join(',');
      setText(description, scenario.description);
      render();
    });

    [srcShapeInput, srcStrideInput, dstShapeInput, dstStrideInput].forEach(function (input) {
      input.addEventListener('input', function () {
        presetSelect.value = 'custom';
        setText(description, 'Custom source and destination layouts.');
        render();
      });
    });

    srcShapeInput.value = COPY_SCENARIOS[0].src.shape.join(',');
    srcStrideInput.value = COPY_SCENARIOS[0].src.stride.join(',');
    dstShapeInput.value = COPY_SCENARIOS[0].dst.shape.join(',');
    dstStrideInput.value = COPY_SCENARIOS[0].dst.stride.join(',');
    presetSelect.value = '0';
    setText(description, COPY_SCENARIOS[0].description);
    render();
  }

  /* ---------------------------------------------------------------------
     Boot
     --------------------------------------------------------------------- */

  var logic = {
    parseList: parseList,
    sizeOf: sizeOf,
    formatLayout: formatLayout,
    coalesceLayout: coalesceLayout,
    greatestCommonDomain: greatestCommonDomain,
    layoutOffsets: layoutOffsets,
    buildGcdAlignmentRows: buildGcdAlignmentRows,
    renderGcdOriginalGraph: renderGcdOriginalGraph,
    renderGcdAlignment: renderGcdAlignment,
    renderGcdGraphs: renderGcdGraphs,
    analyzeCopy: analyzeCopy,
    COPY_SCENARIOS: COPY_SCENARIOS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = logic;
    return;
  }

  if (typeof document === 'undefined') {
    return;
  }

  function boot() {
    initConcept();
    initCoalesce();
    initGcd();
    initCopy();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
