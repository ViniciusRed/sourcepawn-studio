use sourcepawn_lexer::{Symbol, TextRange, TextSize, TokenKind};

use crate::offset::SourceMap;

#[derive(Debug, Default)]
pub struct PreprocessorBuffer {
    contents: String,
    offset: u32,
    source_map: SourceMap,
}

impl PreprocessorBuffer {
    /// Push the whitespaces before the symbol based on the symbol's delta.
    pub fn push_ws(&mut self, symbol: &Symbol) {
        let delta = symbol.delta.unsigned_abs();
        self.offset += delta;
        self.contents.push_str(&" ".repeat(delta as usize));
    }

    // TODO: Test if \n or \r\n matters at all here.
    pub fn push_new_line(&mut self) {
        self.offset += 1;
        self.contents.push('\n');
    }

    pub fn push_new_lines(&mut self, count: u32) {
        for _ in 0..count {
            self.push_new_line();
        }
    }

    pub fn push_symbol(&mut self, symbol: &Symbol) {
        if symbol.token_kind == TokenKind::Eof {
            self.push_new_line();
            return;
        }
        self.push_ws(symbol);
        self.push_symbol_no_delta(symbol);
    }

    pub fn push_symbol_no_delta(&mut self, symbol: &Symbol) {
        self.contents.push_str(&symbol.text());
        if !symbol.range.is_empty() {
            // Symbols with empty ranges are expanded macros.
            self.source_map.push_new_range(
                symbol.range,
                TextRange::at(TextSize::new(self.offset), symbol.range.len()),
            );
        }
        self.offset += symbol.text().len() as u32;
    }

    pub fn push_str(&mut self, string: &str) {
        self.offset += string.len() as u32;
        self.contents.push_str(string);
    }

    pub fn contents(&self) -> &str {
        &self.contents
    }

    pub fn offset(&self) -> u32 {
        self.offset
    }

    pub fn source_map_mut(&mut self) -> &mut SourceMap {
        &mut self.source_map
    }

    pub fn source_map(&self) -> &SourceMap {
        &self.source_map
    }

    pub fn into_source_map(self) -> SourceMap {
        self.source_map
    }
}

impl std::fmt::Display for PreprocessorBuffer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.contents)
    }
}

impl From<PreprocessorBuffer> for String {
    fn from(value: PreprocessorBuffer) -> Self {
        value.to_string()
    }
}