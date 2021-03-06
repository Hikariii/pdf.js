/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  Ascii85Stream, AsciiHexStream, FlateStream, JpegStream, JpxStream, LZWStream,
  NullStream, PredictorStream, RunLengthStream
} from './stream';
import {
  assert, FormatError, info, isNum, isString, MissingDataException, StreamType,
  warn
} from '../shared/util';
import {
  Cmd, Dict, EOF, isCmd, isDict, isEOF, isName, Name, Ref
} from './primitives';
import { CCITTFaxStream } from './ccitt_stream';
import { Jbig2Stream } from './jbig2_stream';

var MAX_LENGTH_TO_CACHE = 1000;

var Parser = (function ParserClosure() {
  function Parser(lexer, allowStreams, xref, recoveryMode) {
    this.lexer = lexer;
    this.allowStreams = allowStreams;
    this.xref = xref;
    this.recoveryMode = recoveryMode || false;
    this.imageCache = Object.create(null);
    this.refill();
  }

  Parser.prototype = {
    refill: function Parser_refill() {
      this.buf1 = this.lexer.getObj();
      this.buf2 = this.lexer.getObj();
    },
    shift: function Parser_shift() {
      if (isCmd(this.buf2, 'ID')) {
        this.buf1 = this.buf2;
        this.buf2 = null;
      } else {
        this.buf1 = this.buf2;
        this.buf2 = this.lexer.getObj();
      }
    },
    tryShift: function Parser_tryShift() {
      try {
        this.shift();
        return true;
      } catch (e) {
        if (e instanceof MissingDataException) {
          throw e;
        }
        // Upon failure, the caller should reset this.lexer.pos to a known good
        // state and call this.shift() twice to reset the buffers.
        return false;
      }
    },
    getObj: function Parser_getObj(cipherTransform) {
      var buf1 = this.buf1;
      this.shift();

      if (buf1 instanceof Cmd) {
        switch (buf1.cmd) {
          case 'BI': // inline image
            return this.makeInlineImage(cipherTransform);
          case '[': // array
            var array = [];
            while (!isCmd(this.buf1, ']') && !isEOF(this.buf1)) {
              array.push(this.getObj(cipherTransform));
            }
            if (isEOF(this.buf1)) {
              if (!this.recoveryMode) {
                throw new FormatError('End of file inside array');
              }
              return array;
            }
            this.shift();
            return array;
          case '<<': // dictionary or stream
            var dict = new Dict(this.xref);
            while (!isCmd(this.buf1, '>>') && !isEOF(this.buf1)) {
              if (!isName(this.buf1)) {
                info('Malformed dictionary: key must be a name object');
                this.shift();
                continue;
              }

              var key = this.buf1.name;
              this.shift();
              if (isEOF(this.buf1)) {
                break;
              }
              dict.set(key, this.getObj(cipherTransform));
            }
            if (isEOF(this.buf1)) {
              if (!this.recoveryMode) {
                throw new FormatError('End of file inside dictionary');
              }
              return dict;
            }

            // Stream objects are not allowed inside content streams or
            // object streams.
            if (isCmd(this.buf2, 'stream')) {
              return (this.allowStreams ?
                      this.makeStream(dict, cipherTransform) : dict);
            }
            this.shift();
            return dict;
          default: // simple object
            return buf1;
        }
      }

      if (Number.isInteger(buf1)) { // indirect reference or integer
        var num = buf1;
        if (Number.isInteger(this.buf1) && isCmd(this.buf2, 'R')) {
          var ref = new Ref(num, this.buf1);
          this.shift();
          this.shift();
          return ref;
        }
        return num;
      }

      if (isString(buf1)) { // string
        var str = buf1;
        if (cipherTransform) {
          str = cipherTransform.decryptString(str);
        }
        return str;
      }

      // simple object
      return buf1;
    },
    /**
     * Find the end of the stream by searching for the /EI\s/.
     * @returns {number} The inline stream length.
     */
    findDefaultInlineStreamEnd(stream) {
      const E = 0x45, I = 0x49, SPACE = 0x20, LF = 0xA, CR = 0xD;
      const n = 10, NUL = 0x0;
      let startPos = stream.pos, state = 0, ch, maybeEIPos;
      while ((ch = stream.getByte()) !== -1) {
        if (state === 0) {
          state = (ch === E) ? 1 : 0;
        } else if (state === 1) {
          state = (ch === I) ? 2 : 0;
        } else {
          assert(state === 2);
          if (ch === SPACE || ch === LF || ch === CR) {
            maybeEIPos = stream.pos;
            // Let's check that the next `n` bytes are ASCII... just to be sure.
            let followingBytes = stream.peekBytes(n);
            for (let i = 0, ii = followingBytes.length; i < ii; i++) {
              ch = followingBytes[i];
              if (ch === NUL && followingBytes[i + 1] !== NUL) {
                // NUL bytes are not supposed to occur *outside* of inline
                // images, but some PDF generators violate that assumption,
                // thus breaking the EI detection heuristics used below.
                //
                // However, we can't unconditionally treat NUL bytes as "ASCII",
                // since that *could* result in inline images being truncated.
                //
                // To attempt to address this, we'll still treat any *sequence*
                // of NUL bytes as non-ASCII, but for a *single* NUL byte we'll
                // continue checking the `followingBytes` (fixes issue8823.pdf).
                continue;
              }
              if (ch !== LF && ch !== CR && (ch < SPACE || ch > 0x7F)) {
                // Not a LF, CR, SPACE or any visible ASCII character, i.e.
                // it's binary stuff. Resetting the state.
                state = 0;
                break;
              }
            }
            if (state === 2) {
              break;  // Finished!
            }
          } else {
            state = 0;
          }
        }
      }

      if (ch === -1) {
        warn('findDefaultInlineStreamEnd: ' +
             'Reached the end of the stream without finding a valid EI marker');
        if (maybeEIPos) {
          warn('... trying to recover by using the last "EI" occurrence.');
          stream.skip(-(stream.pos - maybeEIPos)); // Reset the stream position.
        }
      }
      return ((stream.pos - 4) - startPos);
    },
    /**
     * Find the EOI (end-of-image) marker 0xFFD9 of the stream.
     * @returns {number} The inline stream length.
     */
    findDCTDecodeInlineStreamEnd:
        function Parser_findDCTDecodeInlineStreamEnd(stream) {
      var startPos = stream.pos, foundEOI = false, b, markerLength, length;
      while ((b = stream.getByte()) !== -1) {
        if (b !== 0xFF) { // Not a valid marker.
          continue;
        }
        switch (stream.getByte()) {
          case 0x00: // Byte stuffing.
            // 0xFF00 appears to be a very common byte sequence in JPEG images.
            break;

          case 0xFF: // Fill byte.
            // Avoid skipping a valid marker, resetting the stream position.
            stream.skip(-1);
            break;

          case 0xD9: // EOI
            foundEOI = true;
            break;

          case 0xC0: // SOF0
          case 0xC1: // SOF1
          case 0xC2: // SOF2
          case 0xC3: // SOF3
            /* falls through */
          case 0xC5: // SOF5
          case 0xC6: // SOF6
          case 0xC7: // SOF7
            /* falls through */
          case 0xC9: // SOF9
          case 0xCA: // SOF10
          case 0xCB: // SOF11
            /* falls through */
          case 0xCD: // SOF13
          case 0xCE: // SOF14
          case 0xCF: // SOF15
            /* falls through */
          case 0xC4: // DHT
          case 0xCC: // DAC
            /* falls through */
          case 0xDA: // SOS
          case 0xDB: // DQT
          case 0xDC: // DNL
          case 0xDD: // DRI
          case 0xDE: // DHP
          case 0xDF: // EXP
            /* falls through */
          case 0xE0: // APP0
          case 0xE1: // APP1
          case 0xE2: // APP2
          case 0xE3: // APP3
          case 0xE4: // APP4
          case 0xE5: // APP5
          case 0xE6: // APP6
          case 0xE7: // APP7
          case 0xE8: // APP8
          case 0xE9: // APP9
          case 0xEA: // APP10
          case 0xEB: // APP11
          case 0xEC: // APP12
          case 0xED: // APP13
          case 0xEE: // APP14
          case 0xEF: // APP15
            /* falls through */
          case 0xFE: // COM
            // The marker should be followed by the length of the segment.
            markerLength = stream.getUint16();
            if (markerLength > 2) {
              // |markerLength| contains the byte length of the marker segment,
              // including its own length (2 bytes) and excluding the marker.
              stream.skip(markerLength - 2); // Jump to the next marker.
            } else {
              // The marker length is invalid, resetting the stream position.
              stream.skip(-2);
            }
            break;
        }
        if (foundEOI) {
          break;
        }
      }
      length = stream.pos - startPos;
      if (b === -1) {
        warn('Inline DCTDecode image stream: ' +
             'EOI marker not found, searching for /EI/ instead.');
        stream.skip(-length); // Reset the stream position.
        return this.findDefaultInlineStreamEnd(stream);
      }
      this.inlineStreamSkipEI(stream);
      return length;
    },
    /**
     * Find the EOD (end-of-data) marker '~>' (i.e. TILDE + GT) of the stream.
     * @returns {number} The inline stream length.
     */
    findASCII85DecodeInlineStreamEnd:
        function Parser_findASCII85DecodeInlineStreamEnd(stream) {
      var TILDE = 0x7E, GT = 0x3E;
      var startPos = stream.pos, ch, length;
      while ((ch = stream.getByte()) !== -1) {
        if (ch === TILDE && stream.peekByte() === GT) {
          stream.skip();
          break;
        }
      }
      length = stream.pos - startPos;
      if (ch === -1) {
        warn('Inline ASCII85Decode image stream: ' +
             'EOD marker not found, searching for /EI/ instead.');
        stream.skip(-length); // Reset the stream position.
        return this.findDefaultInlineStreamEnd(stream);
      }
      this.inlineStreamSkipEI(stream);
      return length;
    },
    /**
     * Find the EOD (end-of-data) marker '>' (i.e. GT) of the stream.
     * @returns {number} The inline stream length.
     */
    findASCIIHexDecodeInlineStreamEnd:
        function Parser_findASCIIHexDecodeInlineStreamEnd(stream) {
      var GT = 0x3E;
      var startPos = stream.pos, ch, length;
      while ((ch = stream.getByte()) !== -1) {
        if (ch === GT) {
          break;
        }
      }
      length = stream.pos - startPos;
      if (ch === -1) {
        warn('Inline ASCIIHexDecode image stream: ' +
             'EOD marker not found, searching for /EI/ instead.');
        stream.skip(-length); // Reset the stream position.
        return this.findDefaultInlineStreamEnd(stream);
      }
      this.inlineStreamSkipEI(stream);
      return length;
    },
    /**
     * Skip over the /EI/ for streams where we search for an EOD marker.
     */
    inlineStreamSkipEI: function Parser_inlineStreamSkipEI(stream) {
      var E = 0x45, I = 0x49;
      var state = 0, ch;
      while ((ch = stream.getByte()) !== -1) {
        if (state === 0) {
          state = (ch === E) ? 1 : 0;
        } else if (state === 1) {
          state = (ch === I) ? 2 : 0;
        } else if (state === 2) {
          break;
        }
      }
    },
    makeInlineImage: function Parser_makeInlineImage(cipherTransform) {
      var lexer = this.lexer;
      var stream = lexer.stream;

      // Parse dictionary.
      var dict = new Dict(this.xref);
      while (!isCmd(this.buf1, 'ID') && !isEOF(this.buf1)) {
        if (!isName(this.buf1)) {
          throw new FormatError('Dictionary key must be a name object');
        }
        var key = this.buf1.name;
        this.shift();
        if (isEOF(this.buf1)) {
          break;
        }
        dict.set(key, this.getObj(cipherTransform));
      }

      // Extract the name of the first (i.e. the current) image filter.
      var filter = dict.get('Filter', 'F'), filterName;
      if (isName(filter)) {
        filterName = filter.name;
      } else if (Array.isArray(filter)) {
        var filterZero = this.xref.fetchIfRef(filter[0]);
        if (isName(filterZero)) {
          filterName = filterZero.name;
        }
      }

      // Parse image stream.
      var startPos = stream.pos, length, i, ii;
      if (filterName === 'DCTDecode' || filterName === 'DCT') {
        length = this.findDCTDecodeInlineStreamEnd(stream);
      } else if (filterName === 'ASCII85Decode' || filterName === 'A85') {
        length = this.findASCII85DecodeInlineStreamEnd(stream);
      } else if (filterName === 'ASCIIHexDecode' || filterName === 'AHx') {
        length = this.findASCIIHexDecodeInlineStreamEnd(stream);
      } else {
        length = this.findDefaultInlineStreamEnd(stream);
      }
      var imageStream = stream.makeSubStream(startPos, length, dict);

      // Cache all images below the MAX_LENGTH_TO_CACHE threshold by their
      // adler32 checksum.
      var adler32;
      if (length < MAX_LENGTH_TO_CACHE) {
        var imageBytes = imageStream.getBytes();
        imageStream.reset();

        var a = 1;
        var b = 0;
        for (i = 0, ii = imageBytes.length; i < ii; ++i) {
          // No modulo required in the loop if imageBytes.length < 5552.
          a += imageBytes[i] & 0xff;
          b += a;
        }
        adler32 = ((b % 65521) << 16) | (a % 65521);

        let cacheEntry = this.imageCache[adler32];
        if (cacheEntry !== undefined) {
          this.buf2 = Cmd.get('EI');
          this.shift();

          cacheEntry.reset();
          return cacheEntry;
        }
      }

      if (cipherTransform) {
        imageStream = cipherTransform.createStream(imageStream, length);
      }

      imageStream = this.filter(imageStream, dict, length);
      imageStream.dict = dict;
      if (adler32 !== undefined) {
        imageStream.cacheKey = 'inline_' + length + '_' + adler32;
        this.imageCache[adler32] = imageStream;
      }

      this.buf2 = Cmd.get('EI');
      this.shift();

      return imageStream;
    },
    makeStream: function Parser_makeStream(dict, cipherTransform) {
      var lexer = this.lexer;
      var stream = lexer.stream;

      // get stream start position
      lexer.skipToNextLine();
      var pos = stream.pos - 1;

      // get length
      var length = dict.get('Length');
      if (!Number.isInteger(length)) {
        info('Bad ' + length + ' attribute in stream');
        length = 0;
      }

      // skip over the stream data
      stream.pos = pos + length;
      lexer.nextChar();

      // Shift '>>' and check whether the new object marks the end of the stream
      if (this.tryShift() && isCmd(this.buf2, 'endstream')) {
        this.shift(); // 'stream'
      } else {
        // bad stream length, scanning for endstream
        stream.pos = pos;
        var SCAN_BLOCK_SIZE = 2048;
        var ENDSTREAM_SIGNATURE_LENGTH = 9;
        var ENDSTREAM_SIGNATURE = [0x65, 0x6E, 0x64, 0x73, 0x74, 0x72, 0x65,
                                   0x61, 0x6D];
        var skipped = 0, found = false, i, j;
        while (stream.pos < stream.end) {
          var scanBytes = stream.peekBytes(SCAN_BLOCK_SIZE);
          var scanLength = scanBytes.length - ENDSTREAM_SIGNATURE_LENGTH;
          if (scanLength <= 0) {
            break;
          }
          found = false;
          i = 0;
          while (i < scanLength) {
            j = 0;
            while (j < ENDSTREAM_SIGNATURE_LENGTH &&
                   scanBytes[i + j] === ENDSTREAM_SIGNATURE[j]) {
              j++;
            }
            if (j >= ENDSTREAM_SIGNATURE_LENGTH) {
              found = true;
              break;
            }
            i++;
          }
          if (found) {
            skipped += i;
            stream.pos += i;
            break;
          }
          skipped += scanLength;
          stream.pos += scanLength;
        }
        if (!found) {
          throw new FormatError('Missing endstream');
        }
        length = skipped;

        lexer.nextChar();
        this.shift();
        this.shift();
      }
      this.shift(); // 'endstream'

      stream = stream.makeSubStream(pos, length, dict);
      if (cipherTransform) {
        stream = cipherTransform.createStream(stream, length);
      }
      stream = this.filter(stream, dict, length);
      stream.dict = dict;
      return stream;
    },
    filter: function Parser_filter(stream, dict, length) {
      var filter = dict.get('Filter', 'F');
      var params = dict.get('DecodeParms', 'DP');
      if (isName(filter)) {
        if (Array.isArray(params)) {
          warn('/DecodeParms should not contain an Array, ' +
               'when /Filter contains a Name.');
        }
        return this.makeFilter(stream, filter.name, length, params);
      }

      var maybeLength = length;
      if (Array.isArray(filter)) {
        var filterArray = filter;
        var paramsArray = params;
        for (var i = 0, ii = filterArray.length; i < ii; ++i) {
          filter = this.xref.fetchIfRef(filterArray[i]);
          if (!isName(filter)) {
            throw new FormatError('Bad filter name: ' + filter);
          }

          params = null;
          if (Array.isArray(paramsArray) && (i in paramsArray)) {
            params = this.xref.fetchIfRef(paramsArray[i]);
          }
          stream = this.makeFilter(stream, filter.name, maybeLength, params);
          // after the first stream the length variable is invalid
          maybeLength = null;
        }
      }
      return stream;
    },
    makeFilter: function Parser_makeFilter(stream, name, maybeLength, params) {
      // Since the 'Length' entry in the stream dictionary can be completely
      // wrong, e.g. zero for non-empty streams, only skip parsing the stream
      // when we can be absolutely certain that it actually is empty.
      if (maybeLength === 0) {
        warn('Empty "' + name + '" stream.');
        return new NullStream();
      }
      try {
        var xrefStreamStats = this.xref.stats.streamTypes;
        if (name === 'FlateDecode' || name === 'Fl') {
          xrefStreamStats[StreamType.FLATE] = true;
          if (params) {
            return new PredictorStream(new FlateStream(stream, maybeLength),
                                       maybeLength, params);
          }
          return new FlateStream(stream, maybeLength);
        }
        if (name === 'LZWDecode' || name === 'LZW') {
          xrefStreamStats[StreamType.LZW] = true;
          var earlyChange = 1;
          if (params) {
            if (params.has('EarlyChange')) {
              earlyChange = params.get('EarlyChange');
            }
            return new PredictorStream(
              new LZWStream(stream, maybeLength, earlyChange),
              maybeLength, params);
          }
          return new LZWStream(stream, maybeLength, earlyChange);
        }
        if (name === 'DCTDecode' || name === 'DCT') {
          xrefStreamStats[StreamType.DCT] = true;
          return new JpegStream(stream, maybeLength, stream.dict, params);
        }
        if (name === 'JPXDecode' || name === 'JPX') {
          xrefStreamStats[StreamType.JPX] = true;
          return new JpxStream(stream, maybeLength, stream.dict, params);
        }
        if (name === 'ASCII85Decode' || name === 'A85') {
          xrefStreamStats[StreamType.A85] = true;
          return new Ascii85Stream(stream, maybeLength);
        }
        if (name === 'ASCIIHexDecode' || name === 'AHx') {
          xrefStreamStats[StreamType.AHX] = true;
          return new AsciiHexStream(stream, maybeLength);
        }
        if (name === 'CCITTFaxDecode' || name === 'CCF') {
          xrefStreamStats[StreamType.CCF] = true;
          return new CCITTFaxStream(stream, maybeLength, params);
        }
        if (name === 'RunLengthDecode' || name === 'RL') {
          xrefStreamStats[StreamType.RL] = true;
          return new RunLengthStream(stream, maybeLength);
        }
        if (name === 'JBIG2Decode') {
          xrefStreamStats[StreamType.JBIG] = true;
          return new Jbig2Stream(stream, maybeLength, stream.dict, params);
        }
        warn('filter "' + name + '" not supported yet');
        return stream;
      } catch (ex) {
        if (ex instanceof MissingDataException) {
          throw ex;
        }
        warn('Invalid stream: \"' + ex + '\"');
        return new NullStream();
      }
    },
  };

  return Parser;
})();

var Lexer = (function LexerClosure() {
  function Lexer(stream, knownCommands) {
    this.stream = stream;
    this.nextChar();

    // While lexing, we build up many strings one char at a time. Using += for
    // this can result in lots of garbage strings. It's better to build an
    // array of single-char strings and then join() them together at the end.
    // And reusing a single array (i.e. |this.strBuf|) over and over for this
    // purpose uses less memory than using a new array for each string.
    this.strBuf = [];

    // The PDFs might have "glued" commands with other commands, operands or
    // literals, e.g. "q1". The knownCommands is a dictionary of the valid
    // commands and their prefixes. The prefixes are built the following way:
    // if there a command that is a prefix of the other valid command or
    // literal (e.g. 'f' and 'false') the following prefixes must be included,
    // 'fa', 'fal', 'fals'. The prefixes are not needed, if the command has no
    // other commands or literals as a prefix. The knowCommands is optional.
    this.knownCommands = knownCommands;
  }

  // A '1' in this array means the character is white space. A '1' or
  // '2' means the character ends a name or command.
  var specialChars = [
    1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0, // 0x
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 1x
    1, 0, 0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 0, 0, 0, 2, // 2x
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, // 3x
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 4x
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, 0, // 5x
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 6x
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, 0, // 7x
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 8x
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 9x
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // ax
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // bx
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // cx
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // dx
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // ex
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0  // fx
  ];

  function toHexDigit(ch) {
    if (ch >= 0x30 && ch <= 0x39) { // '0'-'9'
      return ch & 0x0F;
    }
    if ((ch >= 0x41 && ch <= 0x46) || (ch >= 0x61 && ch <= 0x66)) {
      // 'A'-'F', 'a'-'f'
      return (ch & 0x0F) + 9;
    }
    return -1;
  }

  Lexer.prototype = {
    nextChar: function Lexer_nextChar() {
      return (this.currentChar = this.stream.getByte());
    },
    peekChar: function Lexer_peekChar() {
      return this.stream.peekByte();
    },
    getNumber: function Lexer_getNumber() {
      var ch = this.currentChar;
      var eNotation = false;
      var divideBy = 0; // different from 0 if it's a floating point value
      var sign = 1;

      if (ch === 0x2D) { // '-'
        sign = -1;
        ch = this.nextChar();

        if (ch === 0x2D) { // '-'
          // Ignore double negative (this is consistent with Adobe Reader).
          ch = this.nextChar();
        }
      } else if (ch === 0x2B) { // '+'
        ch = this.nextChar();
      }
      if (ch === 0x2E) { // '.'
        divideBy = 10;
        ch = this.nextChar();
      }
      if (ch === 0x0A || ch === 0x0D) { // LF, CR
        // Ignore line-breaks (this is consistent with Adobe Reader).
        do {
          ch = this.nextChar();
        } while (ch === 0x0A || ch === 0x0D);
      }
      if (ch < 0x30 || ch > 0x39) { // '0' - '9'
        throw new FormatError(
          `Invalid number: ${String.fromCharCode(ch)} (charCode ${ch})`);
      }

      var baseValue = ch - 0x30; // '0'
      var powerValue = 0;
      var powerValueSign = 1;

      while ((ch = this.nextChar()) >= 0) {
        if (0x30 <= ch && ch <= 0x39) { // '0' - '9'
          var currentDigit = ch - 0x30; // '0'
          if (eNotation) { // We are after an 'e' or 'E'
            powerValue = powerValue * 10 + currentDigit;
          } else {
            if (divideBy !== 0) { // We are after a point
              divideBy *= 10;
            }
            baseValue = baseValue * 10 + currentDigit;
          }
        } else if (ch === 0x2E) { // '.'
          if (divideBy === 0) {
            divideBy = 1;
          } else {
            // A number can have only one '.'
            break;
          }
        } else if (ch === 0x2D) { // '-'
          // ignore minus signs in the middle of numbers to match
          // Adobe's behavior
          warn('Badly formatted number');
        } else if (ch === 0x45 || ch === 0x65) { // 'E', 'e'
          // 'E' can be either a scientific notation or the beginning of a new
          // operator
          ch = this.peekChar();
          if (ch === 0x2B || ch === 0x2D) { // '+', '-'
            powerValueSign = (ch === 0x2D) ? -1 : 1;
            this.nextChar(); // Consume the sign character
          } else if (ch < 0x30 || ch > 0x39) { // '0' - '9'
            // The 'E' must be the beginning of a new operator
            break;
          }
          eNotation = true;
        } else {
          // the last character doesn't belong to us
          break;
        }
      }

      if (divideBy !== 0) {
        baseValue /= divideBy;
      }
      if (eNotation) {
        baseValue *= Math.pow(10, powerValueSign * powerValue);
      }
      return sign * baseValue;
    },
    getString: function Lexer_getString() {
      var numParen = 1;
      var done = false;
      var strBuf = this.strBuf;
      strBuf.length = 0;

      var ch = this.nextChar();
      while (true) {
        var charBuffered = false;
        switch (ch | 0) {
          case -1:
            warn('Unterminated string');
            done = true;
            break;
          case 0x28: // '('
            ++numParen;
            strBuf.push('(');
            break;
          case 0x29: // ')'
            if (--numParen === 0) {
              this.nextChar(); // consume strings ')'
              done = true;
            } else {
              strBuf.push(')');
            }
            break;
          case 0x5C: // '\\'
            ch = this.nextChar();
            switch (ch) {
              case -1:
                warn('Unterminated string');
                done = true;
                break;
              case 0x6E: // 'n'
                strBuf.push('\n');
                break;
              case 0x72: // 'r'
                strBuf.push('\r');
                break;
              case 0x74: // 't'
                strBuf.push('\t');
                break;
              case 0x62: // 'b'
                strBuf.push('\b');
                break;
              case 0x66: // 'f'
                strBuf.push('\f');
                break;
              case 0x5C: // '\'
              case 0x28: // '('
              case 0x29: // ')'
                strBuf.push(String.fromCharCode(ch));
                break;
              case 0x30: case 0x31: case 0x32: case 0x33: // '0'-'3'
              case 0x34: case 0x35: case 0x36: case 0x37: // '4'-'7'
                var x = ch & 0x0F;
                ch = this.nextChar();
                charBuffered = true;
                if (ch >= 0x30 && ch <= 0x37) { // '0'-'7'
                  x = (x << 3) + (ch & 0x0F);
                  ch = this.nextChar();
                  if (ch >= 0x30 && ch <= 0x37) {  // '0'-'7'
                    charBuffered = false;
                    x = (x << 3) + (ch & 0x0F);
                  }
                }
                strBuf.push(String.fromCharCode(x));
                break;
              case 0x0D: // CR
                if (this.peekChar() === 0x0A) { // LF
                  this.nextChar();
                }
                break;
              case 0x0A: // LF
                break;
              default:
                strBuf.push(String.fromCharCode(ch));
                break;
            }
            break;
          default:
            strBuf.push(String.fromCharCode(ch));
            break;
        }
        if (done) {
          break;
        }
        if (!charBuffered) {
          ch = this.nextChar();
        }
      }
      return strBuf.join('');
    },
    getName: function Lexer_getName() {
      var ch, previousCh;
      var strBuf = this.strBuf;
      strBuf.length = 0;
      while ((ch = this.nextChar()) >= 0 && !specialChars[ch]) {
        if (ch === 0x23) { // '#'
          ch = this.nextChar();
          if (specialChars[ch]) {
            warn('Lexer_getName: ' +
                 'NUMBER SIGN (#) should be followed by a hexadecimal number.');
            strBuf.push('#');
            break;
          }
          var x = toHexDigit(ch);
          if (x !== -1) {
            previousCh = ch;
            ch = this.nextChar();
            var x2 = toHexDigit(ch);
            if (x2 === -1) {
              warn('Lexer_getName: Illegal digit (' +
                   String.fromCharCode(ch) + ') in hexadecimal number.');
              strBuf.push('#', String.fromCharCode(previousCh));
              if (specialChars[ch]) {
                break;
              }
              strBuf.push(String.fromCharCode(ch));
              continue;
            }
            strBuf.push(String.fromCharCode((x << 4) | x2));
          } else {
            strBuf.push('#', String.fromCharCode(ch));
          }
        } else {
          strBuf.push(String.fromCharCode(ch));
        }
      }
      if (strBuf.length > 127) {
        warn('name token is longer than allowed by the spec: ' + strBuf.length);
      }
      return Name.get(strBuf.join(''));
    },
    getHexString: function Lexer_getHexString() {
      var strBuf = this.strBuf;
      strBuf.length = 0;
      var ch = this.currentChar;
      var isFirstHex = true;
      var firstDigit;
      var secondDigit;
      while (true) {
        if (ch < 0) {
          warn('Unterminated hex string');
          break;
        } else if (ch === 0x3E) { // '>'
          this.nextChar();
          break;
        } else if (specialChars[ch] === 1) {
          ch = this.nextChar();
          continue;
        } else {
          if (isFirstHex) {
            firstDigit = toHexDigit(ch);
            if (firstDigit === -1) {
              warn('Ignoring invalid character "' + ch + '" in hex string');
              ch = this.nextChar();
              continue;
            }
          } else {
            secondDigit = toHexDigit(ch);
            if (secondDigit === -1) {
              warn('Ignoring invalid character "' + ch + '" in hex string');
              ch = this.nextChar();
              continue;
            }
            strBuf.push(String.fromCharCode((firstDigit << 4) | secondDigit));
          }
          isFirstHex = !isFirstHex;
          ch = this.nextChar();
        }
      }
      return strBuf.join('');
    },
    getObj: function Lexer_getObj() {
      // skip whitespace and comments
      var comment = false;
      var ch = this.currentChar;
      while (true) {
        if (ch < 0) {
          return EOF;
        }
        if (comment) {
          if (ch === 0x0A || ch === 0x0D) { // LF, CR
            comment = false;
          }
        } else if (ch === 0x25) { // '%'
          comment = true;
        } else if (specialChars[ch] !== 1) {
          break;
        }
        ch = this.nextChar();
      }

      // start reading token
      switch (ch | 0) {
        case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: // '0'-'4'
        case 0x35: case 0x36: case 0x37: case 0x38: case 0x39: // '5'-'9'
        case 0x2B: case 0x2D: case 0x2E: // '+', '-', '.'
          return this.getNumber();
        case 0x28: // '('
          return this.getString();
        case 0x2F: // '/'
          return this.getName();
        // array punctuation
        case 0x5B: // '['
          this.nextChar();
          return Cmd.get('[');
        case 0x5D: // ']'
          this.nextChar();
          return Cmd.get(']');
        // hex string or dict punctuation
        case 0x3C: // '<'
          ch = this.nextChar();
          if (ch === 0x3C) {
            // dict punctuation
            this.nextChar();
            return Cmd.get('<<');
          }
          return this.getHexString();
        // dict punctuation
        case 0x3E: // '>'
          ch = this.nextChar();
          if (ch === 0x3E) {
            this.nextChar();
            return Cmd.get('>>');
          }
          return Cmd.get('>');
        case 0x7B: // '{'
          this.nextChar();
          return Cmd.get('{');
        case 0x7D: // '}'
          this.nextChar();
          return Cmd.get('}');
        case 0x29: // ')'
          // Consume the current character in order to avoid permanently hanging
          // the worker thread if `Lexer.getObject` is called from within a loop
          // containing try-catch statements, since we would otherwise attempt
          // to parse the *same* character over and over (fixes issue8061.pdf).
          this.nextChar();
          throw new FormatError(`Illegal character: ${ch}`);
      }

      // command
      var str = String.fromCharCode(ch);
      var knownCommands = this.knownCommands;
      var knownCommandFound = knownCommands && knownCommands[str] !== undefined;
      while ((ch = this.nextChar()) >= 0 && !specialChars[ch]) {
        // stop if known command is found and next character does not make
        // the str a command
        var possibleCommand = str + String.fromCharCode(ch);
        if (knownCommandFound && knownCommands[possibleCommand] === undefined) {
          break;
        }
        if (str.length === 128) {
          throw new FormatError(`Command token too long: ${str.length}`);
        }
        str = possibleCommand;
        knownCommandFound = knownCommands && knownCommands[str] !== undefined;
      }
      if (str === 'true') {
        return true;
      }
      if (str === 'false') {
        return false;
      }
      if (str === 'null') {
        return null;
      }
      return Cmd.get(str);
    },
    skipToNextLine: function Lexer_skipToNextLine() {
      var ch = this.currentChar;
      while (ch >= 0) {
        if (ch === 0x0D) { // CR
          ch = this.nextChar();
          if (ch === 0x0A) { // LF
            this.nextChar();
          }
          break;
        } else if (ch === 0x0A) { // LF
          this.nextChar();
          break;
        }
        ch = this.nextChar();
      }
    },
  };

  return Lexer;
})();

var Linearization = {
  create: function LinearizationCreate(stream) {
    function getInt(name, allowZeroValue) {
      var obj = linDict.get(name);
      if (Number.isInteger(obj) && (allowZeroValue ? obj >= 0 : obj > 0)) {
        return obj;
      }
      throw new Error('The "' + name + '" parameter in the linearization ' +
                      'dictionary is invalid.');
    }
    function getHints() {
      var hints = linDict.get('H'), hintsLength, item;
      if (Array.isArray(hints) &&
          ((hintsLength = hints.length) === 2 || hintsLength === 4)) {
        for (var index = 0; index < hintsLength; index++) {
          if (!(Number.isInteger(item = hints[index]) && item > 0)) {
            throw new Error('Hint (' + index +
                            ') in the linearization dictionary is invalid.');
          }
        }
        return hints;
      }
      throw new Error('Hint array in the linearization dictionary is invalid.');
    }
    var parser = new Parser(new Lexer(stream), false, null);
    var obj1 = parser.getObj();
    var obj2 = parser.getObj();
    var obj3 = parser.getObj();
    var linDict = parser.getObj();
    var obj, length;
    if (!(Number.isInteger(obj1) && Number.isInteger(obj2) &&
          isCmd(obj3, 'obj') && isDict(linDict) &&
          isNum(obj = linDict.get('Linearized')) && obj > 0)) {
      return null; // No valid linearization dictionary found.
    } else if ((length = getInt('L')) !== stream.length) {
      throw new Error('The "L" parameter in the linearization dictionary ' +
                      'does not equal the stream length.');
    }
    return {
      length,
      hints: getHints(),
      objectNumberFirst: getInt('O'),
      endFirst: getInt('E'),
      numPages: getInt('N'),
      mainXRefEntriesOffset: getInt('T'),
      pageFirst: (linDict.has('P') ? getInt('P', true) : 0),
    };
  },
};

export {
  Lexer,
  Linearization,
  Parser,
};
