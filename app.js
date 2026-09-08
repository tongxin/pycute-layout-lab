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
      Array.prototype.forEach.call(memory.querySelectorAll('.memory-block'), function (block) {
        block.classList.remove('is-active');
      });
    }

    function activateOffset(offset, coordinateLabel) {
      clearActive();
      Array.prototype.forEach.call(grid.querySelectorAll('[data-offset="' + offset + '"]'), function (cell) {
        cell.classList.add('is-active');
      });
      Array.prototype.forEach.call(memory.querySelectorAll('[data-offset="' + offset + '"]'), function (block) {
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

      memory.innerHTML = Array.from(byOffset.keys()).sort(function (a, b) {
        return a - b;
      }).map(function (offset) {
        return (
          '<div class="memory-block" data-offset="' + offset + '" style="--cell-color:' +
          colorForValue(offset, minOffset, maxOffset) + '">' +
          '<strong>#' + offset + '</strong><span>' +
          byOffset.get(offset).join(' · ') + '</span></div>'
        );
      }).join('');

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
        readout.textContent =
          'offset(i,j) = i·' + stride[0] + ' + j·' + stride[1] +
          '. Hover a logical cell to trace it into memory.';
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

  function initGcd() {
    var inputA = document.getElementById('gcd-a');
    var inputB = document.getElementById('gcd-b');
    var error = document.getElementById('gcd-error');
    var factorsA = document.getElementById('gcd-a-factors');
    var factorsB = document.getElementById('gcd-b-factors');
    var factorsResult = document.getElementById('gcd-result-factors');
    var summary = document.getElementById('gcd-summary');

    if (!inputA || !inputB || !factorsA || !factorsB || !factorsResult) {
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

    function factorChips(shape, options) {
      var config = options || {};
      var maxStride = config.strides ? Math.max.apply(null, config.strides.concat([1])) : 1;
      return shape.map(function (value, index) {
        var stride = config.strides ? config.strides[index] : null;
        var color = stride === null
          ? colorForIndex(index, Math.max(1, shape.length))
          : colorForValue(stride, 0, maxStride);
        return (
          '<div class="factor-chip" style="--mode-color:' + color + '">' +
          '<strong>' + value + '</strong>' +
          (stride === null ? '<span>factor</span>' : '<span>@' + stride + '</span>') +
          '</div>'
        );
      }).join('');
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

      factorsA.innerHTML = factorChips(shapeA);
      factorsB.innerHTML = factorChips(shapeB);
      factorsResult.innerHTML = factorChips(result.shape, { strides: result.stride });

      var resultText = formatLayout(result.shape, result.stride);
      summary.innerHTML =
        '<strong>G = ' + resultText + '</strong><br>' +
        'size(G) = ' + sizeG + ' · gcd(|A|, |B|) = ' + sharedSize +
        ' · ' + coverage + '% of the shared size.<br>' +
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

  var COPY_STAGE_LABELS = [
    '0 · Reference',
    '1 · Common',
    '2 · Nullspace',
    '3 · Align',
    '4 · Vector'
  ];

  function initCopy() {
    var select = document.getElementById('copy-scenario');
    var stageTabs = document.getElementById('copy-stages');
    var description = document.getElementById('copy-scenario-description');
    var srcBadge = document.getElementById('copy-src-badge');
    var dstBadge = document.getElementById('copy-dst-badge');
    var srcStrip = document.getElementById('copy-src-strip');
    var dstStrip = document.getElementById('copy-dst-strip');
    var detail = document.getElementById('copy-stage-detail');
    var metrics = document.getElementById('copy-metrics');

    if (!select || !stageTabs || !srcStrip || !dstStrip || !detail || !metrics) {
      return;
    }

    var state = {
      scenarioIndex: 0,
      stage: 0,
      activeIndex: null
    };

    select.innerHTML = COPY_SCENARIOS.map(function (scenario, index) {
      return '<option value="' + index + '">' + scenario.name + '</option>';
    }).join('');

    stageTabs.innerHTML = COPY_STAGE_LABELS.map(function (label, index) {
      return (
        '<button type="button" data-copy-stage="' + index + '" aria-pressed="' +
        (index === 0 ? 'true' : 'false') + '">' + label + '</button>'
      );
    }).join('');

    function scenario() {
      return COPY_SCENARIOS[state.scenarioIndex];
    }

    function activateIndex(index) {
      state.activeIndex = index;
      Array.prototype.forEach.call(document.querySelectorAll('#copy-src-strip .sequence-cell, #copy-dst-strip .sequence-cell'), function (cell) {
        cell.classList.toggle('is-active', Number(cell.getAttribute('data-index')) === index);
      });
    }

    function clearActiveIndex() {
      state.activeIndex = null;
      Array.prototype.forEach.call(document.querySelectorAll('#copy-src-strip .sequence-cell, #copy-dst-strip .sequence-cell'), function (cell) {
        cell.classList.remove('is-active');
      });
    }

    function renderBaseStrips() {
      var current = scenario();
      renderLayoutSequence(srcStrip, current.src, {
        onHover: activateIndex,
        onLeave: clearActiveIndex,
        onClick: activateIndex
      });
      renderLayoutSequence(dstStrip, current.dst, {
        onHover: activateIndex,
        onLeave: clearActiveIndex,
        onClick: activateIndex
      });
      setText(srcBadge, formatLayout(current.src.shape, current.src.stride));
      setText(dstBadge, formatLayout(current.dst.shape, current.dst.stride));
    }

    function renderMetrics() {
      var current = scenario();
      var m = current.metrics;
      metrics.innerHTML = [
        ['Common size', m.commonSize],
        ['Incompat size', m.incompatSize],
        ['Vector width', m.vectorWidth],
        ['Reference writes', m.referenceWrites],
        ['Optimized writes', m.optimizedWrites]
      ].map(function (item) {
        return (
          '<div class="metric"><span>' + item[0] + '</span><strong>' +
          formatNumber(item[1]) + '</strong></div>'
        );
      }).join('');
    }

    function renderStageDetail() {
      var current = scenario();
      var m = current.metrics;
      var srcOffsets = layoutOffsets(current.src);
      var dstOffsets = layoutOffsets(current.dst);
      var html = '';

      if (state.stage === 0) {
        html =
          '<h3>Reference COPY</h3>' +
          '<p>Iterate one flat index <code>i</code> and evaluate both layouts. ' +
          'The colors show the logical element identity; the offsets show where each side lands.</p>' +
          '<div class="layout-line">for i in 0…' + (sizeOf(current.src.shape) - 1) +
          ': dst[i] = src[i]</div>';
      } else if (state.stage === 1) {
        html =
          '<h3>Stage 1 · Common domain</h3>' +
          '<p><code>greatest_common_domain</code> is shape-only. It finds the aligned factor ' +
          'that both layouts can tile. Only this compatible part is eligible for later optimization.</p>' +
          '<div class="layout-line">G = ' + m.common + '</div>' +
          '<div class="visual-header memory-header"><h3>Compat</h3><span class="badge">' +
          m.commonSize + '</span></div>' +
          '<div class="sequence-strip">' +
          sizeStripMarkup(m.commonSize, { color: 'hsl(196 72% 64%)' }) +
          '</div>' +
          '<div class="visual-header memory-header"><h3>InCompat</h3><span class="badge">' +
          m.incompatSize + '</span></div>' +
          '<div class="sequence-strip">' +
          sizeStripMarkup(m.incompatSize, { color: 'var(--panel-soft)' }) +
          '</div>';
      } else if (state.stage === 2) {
        if (m.nullSize > 1) {
          var dropped = Math.max(0, m.nullSize - 1);
          html =
            '<h3>Stage 2 · Nullspace</h3>' +
            '<p><code>nullspace(dst)</code> collects coordinates that share one destination address. ' +
            'The source is constant across them, so all but one write can be dropped.</p>' +
            '<div class="layout-line">nullspace(dst) = ' + m.nullspace +
            ' · duplicate writes removed: ' + dropped + '</div>' +
            '<div class="sequence-strip">' +
            sizeStripMarkup(m.nullSize, { color: 'hsl(42 86% 62%)', subLabel: '@0' }) +
            '</div>';
        } else {
          html =
            '<h3>Stage 2 · Nullspace</h3>' +
            '<p>This example has no stride-0 aliasing in the destination, so there are no duplicate writes to remove.</p>' +
            '<div class="layout-line">nullspace(dst) = ' + m.nullspace + '</div>';
        }
      } else if (state.stage === 3) {
        var aligned = srcOffsets.map(function (_, index) { return index; });
        aligned.sort(function (left, right) {
          return (dstOffsets[left] - dstOffsets[right]) || (left - right);
        });
        var alignedOffsets = aligned.map(function (index) { return dstOffsets[index]; });
        html =
          '<h3>Stage 3 · Alignment</h3>' +
          '<p><code>right_inverse(dst)</code> reorders the loop into destination-memory order. ' +
          'Both layouts are permuted together, so the elements still match.</p>' +
          '<div class="layout-line">right_inverse(dst) = ' + m.invDst + '</div>' +
          '<div class="visual-header memory-header"><h3>Reference order</h3><span class="badge">destination offsets</span></div>' +
          '<div class="sequence-strip">' + sequenceMarkup(dstOffsets) + '</div>' +
          '<div class="visual-header memory-header"><h3>Aligned order</h3><span class="badge">ascending destination offsets</span></div>' +
          '<div class="sequence-strip">' + sequenceMarkup(alignedOffsets, {
            indices: aligned,
            colorTotal: srcOffsets.length
          }) + '</div>';
      } else {
        var vectorCells = [];
        for (var vectorIndex = 0; vectorIndex < m.vectorWidth; vectorIndex += 1) {
          vectorCells.push(
            '<div class="vector-cell" style="--cell-color:' +
            colorForIndex(vectorIndex, m.vectorWidth) + '">' + vectorIndex + '</div>'
          );
        }
        html =
          '<h3>Stage 4 · Vector run</h3>' +
          '<p>The vector width is the leading contiguous run of the aligned source. ' +
          'When the leading stride is not 1, the copy falls back to scalar.</p>' +
          '<div class="layout-line">aligned src lead = ' + m.srcLead +
          ' · vector width V = ' + m.vectorWidth + '</div>' +
          '<div class="vector-strip">' + vectorCells.join('') + '</div>';
      }

      detail.innerHTML = html;
    }

    function render() {
      var current = scenario();
      setText(description, current.description);
      renderBaseStrips();
      renderMetrics();
      renderStageDetail();
      Array.prototype.forEach.call(stageTabs.querySelectorAll('[data-copy-stage]'), function (button) {
        button.setAttribute(
          'aria-pressed',
          Number(button.getAttribute('data-copy-stage')) === state.stage ? 'true' : 'false'
        );
      });
    }

    select.addEventListener('change', function () {
      state.scenarioIndex = Number(select.value);
      state.stage = 0;
      render();
    });

    stageTabs.addEventListener('click', function (event) {
      var button = event.target.closest('[data-copy-stage]');
      if (!button) {
        return;
      }
      state.stage = Number(button.getAttribute('data-copy-stage'));
      render();
    });

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
