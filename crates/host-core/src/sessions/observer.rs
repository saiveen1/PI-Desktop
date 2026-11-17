//! Per-conversation consent, independent of operating mode and tool permission.
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", try_from = "String")]
pub enum ObserverMode {
    #[default]
    Off,
    Observe,
    Guard,
}

impl ObserverMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Observe => "observe",
            Self::Guard => "guard",
        }
    }
}

impl TryFrom<String> for ObserverMode {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "off" => Ok(Self::Off),
            "observe" => Ok(Self::Observe),
            "guard" => Ok(Self::Guard),
            _ => Err("observerMode must be off, observe, or guard"),
        }
    }
}

impl ToSql for ObserverMode {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(
            self.as_str().as_bytes(),
        )))
    }
}

impl FromSql for ObserverMode {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        match value.as_str()? {
            "off" => Ok(Self::Off),
            "observe" => Ok(Self::Observe),
            "guard" => Ok(Self::Guard),
            _ => Err(FromSqlError::InvalidType),
        }
    }
}
